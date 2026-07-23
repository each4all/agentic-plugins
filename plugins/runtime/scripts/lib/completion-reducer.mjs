// plugins/runtime/scripts/lib/completion-reducer.mjs
//
// The COMPLETION REDUCER (machine-bootstrap-contract.md §7, §8, §8.1) — the thing
// that decides whether a machine is `complete`, `configured-not-verified`, or
// `incomplete`, and the reason this is a command rather than a settings flag.
//
// WHAT IT REFUSES TO READ, and why those are named rather than merely absent (§7's
// two traps, both load-bearing):
//
//   1. `settings.overall.status` is NOT inherited. That summary counts plugin
//      recommendations but does not gate pass/warn on them — only failures enter its
//      status condition — so inheriting it reports a pass while plugins are missing.
//   2. `plugin_management.summary.blocked` is NOT consulted. It is omitted from
//      top-level completion calculations upstream. This reducer inspects blocked /
//      manual-follow-up / unknown step states DIRECTLY.
//
// Neither is imported here. That is the enforcement: a module that cannot see a value
// cannot accidentally trust it, and tests/runtime/test-completion-reducer.mjs asserts
// the absence statically rather than hoping.
//
// STORED STATE IS NEVER EVIDENCE (§7). The manifest records choices and history; every
// plan/status/resume/verify re-probes. So:
//   * `proofs[].status` is RECOMPUTED from `directions` on every read — a stored
//     `passed` beside a failed direction is a claim its own evidence contradicts.
//   * freshness compares bound versions against the CURRENT probe, by exact key set
//     and value. A step satisfied against Codex 0.136 says nothing about 0.140.
//   * a step's stage/applicability/declinable/blocked_by come from the registry, never
//     from the manifest's copy of them.

import { DIRECTIONAL_PROOF_KINDS, PROOF_KINDS, evidenceKindIssues } from './evidence-contract.mjs';
import { RESOLVED_STEP_STATUSES, CONFIG_STAGES, PROOF_STAGES, deriveExpectedSteps, expectedStepIds, stepIds } from './step-registry.mjs';

export const COMPLETION_STATES = Object.freeze(['complete', 'configured-not-verified', 'incomplete']);
export const PROOF_STATUSES = Object.freeze(['passed', 'failed', 'stale', 'not-applicable', 'absent']);
export const DIRECTIONS = Object.freeze(['claude->codex', 'codex->claude']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Bound versions
// ---------------------------------------------------------------------------

/**
 * The version set a proof recorded NOW would bind: runtime, both host CLIs, and every
 * SELECTED plugin's installed version per host (§8.1 — "binds the plugin versions too,
 * not only runtime and the two CLIs").
 *
 * Built from the probe, so freshness compares evidence against observation rather than
 * against another stored claim.
 */
export function currentBoundVersions({ probe, selection, runtimeVersion }) {
  const plugins = { claude: {}, codex: {} };
  for (const host of ['claude', 'codex']) {
    for (const name of [...new Set(selection.plugins ?? [])].sort()) {
      const observed = probe?.hosts?.[host]?.plugins?.[name];
      // Only an INSTALLED version binds. A missing/unknown plugin contributes no key,
      // which is what makes the key-set comparison below meaningful: a proof recorded
      // when a plugin was absent must not read as current once it is installed.
      if (observed?.state === 'installed' && typeof observed.version === 'string') plugins[host][name] = observed.version;
    }
  }
  return {
    runtime: runtimeVersion,
    claude: probe?.hosts?.claude?.cli_version ?? null,
    codex: probe?.hosts?.codex?.cli_version ?? null,
    plugins,
  };
}

/**
 * Compare a proof's bound versions against the current set. Returns { fresh, reasons }.
 *
 * Exact key SETS and values (§8.1). A `null` on either side is never "matching
 * unknown": a missing or null required version never counts as current, because "we
 * could not tell" is not evidence that nothing changed — the same rule §6 states for
 * step status.
 */
export function boundVersionsFresh(bound, current, { requiredPlugins = null } = {}) {
  const reasons = [];
  if (!isPlainObject(bound)) return { fresh: false, reasons: ['the proof carries no bound_versions'] };

  for (const key of ['runtime', 'claude', 'codex']) {
    const a = bound[key] ?? null;
    const b = current[key] ?? null;
    // A null on EITHER side is never current — including null-vs-null. "We could not
    // tell then and we cannot tell now" is not evidence that nothing changed; it is two
    // unknowns agreeing, which is the shape of a proof binding nothing at all. The
    // contract says it plainly: a missing or null required version never counts as
    // current.
    if (a === null || b === null) {
      reasons.push(`${key} version is ${a ?? 'null'} in the proof and ${b ?? 'null'} now — a null version never counts as current`);
      continue;
    }
    if (a !== b) reasons.push(`${key} ${a} → ${b}`);
  }

  for (const host of ['claude', 'codex']) {
    const a = bound.plugins?.[host] ?? {};
    const b = current.plugins?.[host] ?? {};
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.join(',') !== bKeys.join(',')) {
      // A `{}` map is the pathological case worth naming: it binds NOTHING, so a
      // key-set comparison is the only thing standing between it and "always fresh".
      reasons.push(`${host} plugin set bound {${aKeys.join(', ') || 'nothing'}} but the selection now observes {${bKeys.join(', ') || 'nothing'}}`);
      continue;
    }
    for (const name of aKeys) {
      if (a[name] !== b[name]) reasons.push(`${host} ${name} ${a[name]} → ${b[name]}`);
    }

    // The key sets AGREEING is not enough when both are empty and the selection has
    // plugins: `{}` equals `{}`, so a proof that bound no selected plugin version at
    // all would compare fresh forever. §8.1 requires bound_versions to bind EVERY
    // selected plugin, so the expected set — not the observed one — is the yardstick.
    for (const name of requiredPlugins?.[host] ?? []) {
      if (typeof a[name] !== 'string') reasons.push(`${host} ${name} is in the selection but the proof binds no version for it`);
    }
  }
  return { fresh: reasons.length === 0, reasons };
}

/**
 * The per-host plugin names a proof's bound_versions must cover — the selection,
 * restricted to the hosts each plugin actually targets (§8.1). Derived from the
 * validated plugin-set, like everything else the registry owns.
 */
export function requiredBoundPlugins({ pluginSet, selection }) {
  const required = { claude: [], codex: [] };
  for (const name of [...new Set(selection.plugins ?? [])].sort()) {
    for (const host of pluginSet.plugins?.[name]?.hosts ?? []) {
      if (host in required) required[host].push(name);
    }
  }
  return required;
}

// ---------------------------------------------------------------------------
// Proof aggregate — recomputed, never trusted
// ---------------------------------------------------------------------------

/**
 * Recompute a proof's aggregate status from its per-direction results and freshness.
 * The stored `status` is IGNORED entirely — it is not an input to this function, and
 * that is deliberate: §5 says the aggregate is "recomputed from directions, never
 * trusted from storage", and the only way to honour that is to not look.
 *
 * `passed` requires EVERY direction to have passed. A smoke that succeeded
 * claude->codex and failed codex->claude is `failed` (test #22) — the cross-host
 * bridge is not half-working, it is not working.
 */
export function recomputeProofStatus(proof, { current, applicable = true, requiredPlugins = null, currentActivationFingerprint = null }) {
  if (!applicable) return { status: 'not-applicable', reasons: [] };
  if (!isPlainObject(proof)) return { status: 'absent', reasons: ['no proof record'] };

  // egress-provider-ack (ADR-0048 §3) — single-delivery evidence: the aggregate
  // comes from `provider_ack.result`, and freshness additionally binds the
  // SANITIZED activation identity by EQUALITY. An activation that was removed
  // or changed (channel/recipient swap) stales the proof — it never vanishes
  // into `not-applicable`, because removal is a staleness fact about recorded
  // evidence, not a retraction of it.
  if (proof.kind === 'egress-provider-ack') {
    const ack = proof.provider_ack;
    if (!isPlainObject(ack)) return { status: 'absent', reasons: ['no provider_ack evidence recorded'] };
    if (ack.result !== 'acked') {
      return { status: 'failed', reasons: ['the provider request did not return an acknowledged response'] };
    }
    const freshness = boundVersionsFresh(proof.bound_versions, current, { requiredPlugins });
    if (!freshness.fresh) return { status: 'stale', reasons: freshness.reasons };
    if (currentActivationFingerprint === null) {
      return { status: 'stale', reasons: ['no egress activation is currently configured — the acked attempt was recorded against an activation this machine no longer carries'] };
    }
    if (ack.activation_fingerprint !== currentActivationFingerprint) {
      return { status: 'stale', reasons: ['the egress activation changed since this proof was recorded (channel/recipient/credential identity drift) — re-execute against the current activation'] };
    }
    return { status: 'passed', reasons: [] };
  }

  const results = DIRECTIONS.map((d) => ({ direction: d, status: proof.directions?.[d]?.status ?? 'absent' }));
  const failed = results.filter((r) => r.status !== 'passed');
  if (failed.length === DIRECTIONS.length && failed.every((r) => r.status === 'absent')) {
    return { status: 'absent', reasons: ['no direction has run'] };
  }
  if (failed.length > 0) {
    return { status: 'failed', reasons: failed.map((r) => `${r.direction} is ${r.status}`) };
  }

  const freshness = boundVersionsFresh(proof.bound_versions, current, { requiredPlugins });
  if (!freshness.fresh) return { status: 'stale', reasons: freshness.reasons };
  return { status: 'passed', reasons: [] };
}

/**
 * The Codex `/hooks` attestation, evaluated on the same terms (§5/§8.1). It stales on
 * a Codex CLI change, a hook-plugin add/remove/version change, or a disabled expected
 * hook (test #24) — the last at the INDIVIDUAL-HANDLER grain (S8a5): the plugin-level
 * `state` check below cannot see a single `enabled = false` handler inside an
 * installed plugin, so the persisted `probe.hosts.codex.hook_state.disabled_expected`
 * rows are consulted too, and a probe carrying NO available hook-state observation
 * never supports a current claim (the field is structurally optional for 1.0 reads,
 * semantically required here — resume-means-re-probe supplies it, §7).
 *
 * It is an operator CLAIM, not host truth — runtime cannot query Codex trust
 * non-interactively (ADR-0030) — so the only thing that can be checked is whether the
 * claim still covers what it was made about.
 */
export function recomputeHookAttestation(record, { current, expectedPlugins, probe, applicable }) {
  if (!applicable) return { status: 'not-applicable', reasons: [] };
  if (!isPlainObject(record)) return { status: 'absent', reasons: ['no attestation record'] };

  const reasons = [];
  const attested = [...new Set(record.attested_plugins ?? [])].sort();
  const expected = [...new Set(expectedPlugins ?? [])].sort();
  if (attested.join(',') !== expected.join(',')) {
    reasons.push(`the attestation covers {${attested.join(', ') || 'nothing'}} but the selection's Codex hook-bearing set is {${expected.join(', ') || 'nothing'}}`);
  }

  const boundCodex = record.bound_versions?.codex ?? null;
  if (boundCodex === null || current.codex === null || boundCodex !== current.codex) {
    reasons.push(`attested against Codex ${boundCodex ?? 'null'} but the machine now reports ${current.codex ?? 'null'} — hook trust is version-bound (ADR-0030)`);
  }

  const boundPlugins = record.bound_versions?.plugins?.codex ?? {};
  // An EXTRA bound key is drift too: the attestation covers a plugin the selection no
  // longer carries, so it was made about a different machine shape.
  for (const name of Object.keys(boundPlugins).sort()) {
    if (!expected.includes(name)) reasons.push(`the attestation binds ${name}, which is not in the selection's Codex hook-bearing set`);
  }
  for (const name of expected) {
    const bound = boundPlugins[name] ?? null;
    const now = current.plugins?.codex?.[name] ?? null;
    // Both-undefined must NOT compare equal. `undefined === undefined` let an
    // attestation that bound NO version pass for a plugin that is not even installed —
    // an operator claim about hooks that cannot be firing.
    if (bound === null || now === null || bound !== now) {
      reasons.push(`${name} was attested at ${bound ?? 'null'} and is now ${now ?? 'null'} — an unbound or unknown version is never current`);
    }
    // A hook plugin that is not INSTALLED and enabled cannot be bearing hooks, whatever
    // was attested (§5). `disabled` is the case the contract names; `missing` and
    // `unknown` are the same claim with less evidence behind it.
    const state = probe?.hosts?.codex?.plugins?.[name]?.state ?? 'unknown';
    if (state !== 'installed') {
      reasons.push(`${name} is ${state} on Codex, so its attested hooks are not active`);
    }
  }

  // PER-HANDLER disabled evidence (S8a5). The plugin-level check above false-passed
  // an installed plugin with one explicitly disabled handler: `state === 'installed'`
  // is true, and the pre-1.1 probe carried nothing finer. The persisted hook_state is
  // SEMANTICALLY required for a current claim — "we could not observe the hook state"
  // is not evidence the hooks are on, the same rule §8.1 applies to a null version.
  const hookState = probe?.hosts?.codex?.hook_state;
  if (!isPlainObject(hookState)) {
    reasons.push('the probe carries no Codex hook-state observation (pre-1.1 probe), so per-handler disabled state is unknown — re-probe to record it');
  } else if (hookState.observation !== 'available') {
    reasons.push(`the Codex hook-state config was ${hookState.observation === 'missing' ? 'not found' : 'not readable'} at probe time — trust is recorded there, so the attested hook state cannot be standing`);
  } else if (!Array.isArray(hookState.disabled_expected)) {
    // Malformed evidence FAILS CLOSED (peer finding): an `available` observation whose
    // disabled_expected is null/missing/not-an-array is not "no disabled handlers" —
    // it is evidence that does not parse, and treating it as [] is the same fail-open
    // this module refuses everywhere else (§7: a claim its own evidence cannot back).
    reasons.push('the probe hook-state evidence is malformed (disabled_expected is not an array) — malformed evidence never supports a current claim; re-probe');
  } else {
    for (const row of hookState.disabled_expected) {
      if (!expected.includes(row?.plugin)) continue;
      const coords = [row.event, row.group_index, row.hook_index].filter((v) => v !== null && v !== undefined).join(':');
      reasons.push(`${row.plugin} has an explicitly disabled hook handler (${row.hooks_path ?? 'unknown path'}${coords ? `:${coords}` : ''}) — a disabled handler bears no hook, whatever sibling handlers are enabled`);
    }
  }

  return reasons.length > 0 ? { status: 'stale', reasons } : { status: 'attested', reasons: [] };
}

/**
 * The owner receipt-attestation verdict (ADR-0048 §3 / D0.1) — human testimony,
 * re-judged on the same recompute-never-trust terms as every other claim. The
 * verb domain is `attested`, never `passed`: a machine cannot promote a
 * phone-receipt claim to proof, only check whether the claim still stands.
 *
 *   * `attested` requires the LINKED egress-provider-ack proof to still re-judge
 *     `passed` at current bound versions AND both links to hold by equality:
 *     the attempt hash (which synthetic attempt the owner saw) and the stored
 *     provider-proof file hash (that the record they testified about is the
 *     one still on disk).
 *   * Any drift — ack stale/failed, replaced provider proof, mismatched
 *     attempt — is `stale`, with the reason named. Testimony never silently
 *     disappears into `not-applicable` on drift: recorded testimony about a
 *     removed activation is STALE testimony, not retracted testimony.
 *   * `not-applicable` is reserved for a run that never opted into the egress
 *     proof at all.
 */
export function recomputeReceiptAttestation({ record, providerAckSha256 = null, providerAckAttemptHash = null, ackStatus, applicable = true }) {
  const empty = { attested_at: null, attempt_hash: null, provider_proof_artifact_hash: null };
  if (!applicable) return { status: 'not-applicable', reasons: [], ...empty };
  if (!isPlainObject(record)) return { status: 'absent', reasons: [], ...empty };

  const carried = {
    attested_at: matchOr(record.attested_at, TIMESTAMP_RE),
    attempt_hash: matchOr(record.attempt_hash, SHA256_RE),
    provider_proof_artifact_hash: matchOr(record.provider_proof_artifact_hash, SHA256_RE),
  };
  const reasons = [];
  if (ackStatus !== 'passed') {
    reasons.push(`the linked egress-provider-ack proof re-judges ${ackStatus ?? 'absent'} — testimony about an attempt whose machine evidence no longer stands is stale`);
  }
  if (carried.provider_proof_artifact_hash === null || providerAckSha256 === null || carried.provider_proof_artifact_hash !== providerAckSha256) {
    reasons.push('the provider-proof file the receipt links to is not the one on disk (replaced or missing) — the testimony names evidence that no longer exists');
  }
  if (carried.attempt_hash === null || providerAckAttemptHash === null || carried.attempt_hash !== providerAckAttemptHash) {
    reasons.push('the receipt names a different synthetic attempt than the recorded provider proof — testimony about another attempt does not cover this one');
  }
  return reasons.length > 0 ? { status: 'stale', reasons, ...carried } : { status: 'attested', reasons: [], ...carried };
}

// ---------------------------------------------------------------------------
// Invalidation (§7)
// ---------------------------------------------------------------------------

/**
 * Reset recorded step state to `pending` — stamped with `invalidated` — when the
 * versions it was observed against have changed (§7, test #13).
 *
 * "Resume means re-probe": a step is `satisfied` because a post-probe SAW the desired
 * state, and that observation is only as good as the versions it was made against.
 * Trusting the record instead is how a bootstrap tells an operator their hooks are
 * trusted after the upgrade that untrusted them.
 */
export function invalidateStaleSteps({ steps, probe, current, selection = null, at }) {
  // The stored probe's plugin map is filtered to the SAME selected set
  // `currentBoundVersions` uses. Comparing every installed plugin against only the
  // selected ones makes an unselected-but-installed plugin (a `designer` on a `base`
  // machine) a permanent key-set mismatch — every run would reset every satisfied step
  // and re-probe forever, with a drift reason naming a plugin nobody selected.
  const drift = boundVersionsFresh(
    { runtime: probe?.runtime_version ?? null, claude: probe?.hosts?.claude?.cli_version ?? null, codex: probe?.hosts?.codex?.cli_version ?? null, plugins: probeInstalledPlugins(probe, selection) },
    current,
  );
  if (drift.fresh) return { steps, invalidated: [], reasons: [] };

  const invalidated = [];
  const next = steps.map((step) => {
    // Only a VERSION-BOUND status can go stale: an observation (`satisfied`) or a
    // rendered hand-off (`manual-follow-up`, which carries a fragment and an apply
    // command produced against those versions — showing an operator stale instructions
    // is its own failure). A pending/blocked step has nothing to invalidate, and a
    // `declined` is an operator CHOICE recorded in choices[], not an observation:
    // re-asking them because Codex shipped a patch would be noise, not rigour.
    if (step.status !== 'satisfied' && step.status !== 'manual-follow-up') return step;
    invalidated.push(step.id);
    return { ...step, status: 'pending', observed: null, observed_at: null, fragment_pointer: null, apply_command: null, invalidated: { at, reason: 'version-drift' } };
  });
  return { steps: next, invalidated, reasons: drift.reasons };
}

function probeInstalledPlugins(probe, selection) {
  const selected = selection ? new Set(selection.plugins ?? []) : null;
  const plugins = { claude: {}, codex: {} };
  for (const host of ['claude', 'codex']) {
    for (const [name, info] of Object.entries(probe?.hosts?.[host]?.plugins ?? {})) {
      if (selected && !selected.has(name)) continue;
      if (info?.state === 'installed' && typeof info.version === 'string') plugins[host][name] = info.version;
    }
  }
  return plugins;
}

// ---------------------------------------------------------------------------
// §8.2 — the proof importer
// ---------------------------------------------------------------------------

// The keys a proof record may carry into the machine-global home. An ALLOWLIST, so a
// doctor artifact that grows a new field cannot carry it here by default — the §8.2
// rule is "metadata only", and "everything except the fields we thought to exclude"
// is not that rule.
const PROOF_METADATA_KEYS = Object.freeze(['kind', 'status', 'directions', 'provider_ack', 'artifact_pointer', 'artifact_hash', 'bound_versions', 'ran_at']);
const DIRECTION_KEYS = Object.freeze(['status', 'ran_at']);

/**
 * Import a doctor proof into the machine-global run (§8.2), METADATA ONLY.
 *
 * Doctor records proofs REPO-RELATIVE, so a bootstrap run from repository B cannot
 * discover evidence recorded in repository A — for a *machine* bootstrap that is a
 * defect, not a nuance. This copies the pointer, hash, bound versions and per-direction
 * results into `~/.agentic-plugins/runs/bootstrap/<run-id>/proof/`.
 *
 * Raw peer output is NEVER copied and never printed. That is why this projects onto an
 * allowlist rather than deleting known-bad keys: a proof whose stdout landed in a field
 * nobody enumerated would otherwise be carried into a file the operator may well paste
 * into an issue.
 *
 * The `status` is carried for provenance only — the reducer recomputes it from
 * `directions` and never reads it back (see recomputeProofStatus).
 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const POINTER_RE = /^[~.][A-Za-z0-9/._-]{0,511}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DIRECTION_STATUSES = Object.freeze(['passed', 'failed', 'blocked', 'absent']);
const PROVIDER_ACK_RESULTS = Object.freeze(['acked', 'failed']);
// The proof-kind vocabulary is OWNED by lib/evidence-contract.mjs (ADR-0048 §3)
// — one table for importer, writer, reader, and reducer, so the kinds cannot
// drift between them. Re-exported here because §8.2 consumers historically
// import it from the reducer.
export { PROOF_KINDS, DIRECTIONAL_PROOF_KINDS };

// Every scalar is RECONSTRUCTED against its own grammar, not merely copied. A top-level
// allowlist stops a raw-output key at the door and then waves through whatever is nested
// inside an allowed one — `artifact_pointer: "RAW PEER OUTPUT"` and
// `bound_versions.plugins.claude.raw_output: "SECRET"` both satisfy "the key is on the
// list". §8.2's rule is metadata-only, and a string is only metadata if it is the shape
// the metadata is supposed to be.
const enumOr = (value, allowed, fallback = null) => (allowed.includes(value) ? value : fallback);
const matchOr = (value, re) => (typeof value === 'string' && re.test(value) ? value : null);

function importVersionMap(map) {
  const out = {};
  if (!isPlainObject(map)) return out;
  for (const [name, version] of Object.entries(map)) {
    // A plugin name that is not a plugin name, or a version that is not a version, is
    // not metadata — it is something else wearing the key.
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) continue;
    const clean = matchOr(version, SEMVER_RE);
    if (clean !== null) out[name] = clean;
  }
  return out;
}

export function importProofMetadata(doctorProof) {
  if (!isPlainObject(doctorProof)) return { ok: false, errors: ['proof record is not an object'], record: null };

  const kind = enumOr(doctorProof.kind, PROOF_KINDS);
  const bound = doctorProof.bound_versions;
  const record = {
    kind,
    // Carried for provenance only — the reducer recomputes it and never reads this back.
    status: enumOr(doctorProof.status, PROOF_STATUSES, 'absent'),
    artifact_pointer: matchOr(doctorProof.artifact_pointer, POINTER_RE),
    artifact_hash: matchOr(doctorProof.artifact_hash, SHA256_RE),
    bound_versions: {
      runtime: matchOr(bound?.runtime, SEMVER_RE),
      claude: matchOr(bound?.claude, SEMVER_RE),
      codex: matchOr(bound?.codex, SEMVER_RE),
      plugins: { claude: importVersionMap(bound?.plugins?.claude), codex: importVersionMap(bound?.plugins?.codex) },
    },
    ran_at: matchOr(doctorProof.ran_at, TIMESTAMP_RE),
  };

  // Kind-discriminated evidence member (ADR-0048 §3): the importer reconstructs
  // EXACTLY the member the kind carries — a directional record gets its
  // per-direction map, an egress-provider-ack record gets its provider_ack —
  // and NEVER both. The source carrying the other kind's member is reported as
  // dropped, and evidenceKindIssues re-checks the reconstruction below so the
  // importer can never emit a record the writer/reader boundaries would refuse.
  if (kind === 'egress-provider-ack') {
    const ack = doctorProof.provider_ack;
    record.provider_ack = {
      result: enumOr(ack?.result, PROVIDER_ACK_RESULTS, 'failed'),
      attempt_hash: matchOr(ack?.attempt_hash, SHA256_RE),
      activation_fingerprint: matchOr(ack?.activation_fingerprint, SHA256_RE),
      ran_at: matchOr(ack?.ran_at, TIMESTAMP_RE),
    };
    if (record.provider_ack.attempt_hash === null || record.provider_ack.activation_fingerprint === null) {
      return { ok: false, errors: ['provider_ack must carry a non-null attempt_hash and activation_fingerprint (sha256)'], record: null };
    }
  } else {
    const directions = {};
    for (const direction of DIRECTIONS) {
      const source = doctorProof.directions?.[direction];
      // Every direction is written explicitly: a direction that did not run says
      // `absent` rather than being missing, so an empty map can never read as a pass.
      directions[direction] = isPlainObject(source)
        ? { status: enumOr(source.status, DIRECTION_STATUSES, 'absent'), ran_at: matchOr(source.ran_at, TIMESTAMP_RE) }
        : { status: 'absent', ran_at: null };
    }
    record.directions = directions;
  }

  const kindIssues = kind === null ? ['kind (not a known proof kind)'] : evidenceKindIssues(kind, record);
  if (kindIssues.length > 0) return { ok: false, errors: kindIssues, record: null };

  const dropped = [
    ...Object.keys(doctorProof).filter((k) => !PROOF_METADATA_KEYS.includes(k)),
    // Anything that WAS on the list but failed its grammar is dropped too, and said so
    // — silently nulling a field the caller believed it passed is how a proof ends up
    // bound to nothing.
    ...(doctorProof.artifact_pointer !== undefined && record.artifact_pointer === null ? ['artifact_pointer (not a pointer)'] : []),
    ...(kind === 'egress-provider-ack' && doctorProof.directions !== undefined ? ['directions (forbidden for egress-provider-ack)'] : []),
    ...(kind !== null && kind !== 'egress-provider-ack' && doctorProof.provider_ack !== undefined ? ['provider_ack (forbidden for directional kinds)'] : []),
  ].sort();
  return { ok: true, errors: [], record, dropped };
}

/**
 * Import a doctor Codex `/hooks` attestation summary into the machine-global run (§8.2),
 * SELECTION-AWARE and METADATA ONLY — the same reconstruct-every-scalar discipline as
 * importProofMetadata, applied to an operator claim.
 *
 * `expectedPlugins` is THIS bootstrap's Codex-hook-bearing selection. A settings run attests
 * every INSTALLED hook plugin machine-wide, so the importer PROJECTS that down to exactly the
 * selection:
 *   - a selected plugin the source does not cover, or binds no version for, is a REJECT — the
 *     attestation was made about a different machine shape, and a partial copy would read as a
 *     valid claim about hooks nobody attested;
 *   - a machine-wide plugin OUTSIDE the selection is simply not copied.
 *
 * A legacy attestation carrying no bound_versions.codex is importable, but ONLY as a record
 * whose codex version is null — which the reducer reads as never-current until re-recorded.
 * It is never silently rebound to the current version. When BOTH the legacy plugin_versions
 * map and the canonical bound_versions.plugins.codex map bind a plugin and DISAGREE, the
 * record is refused rather than one map silently chosen.
 *
 * artifact_pointer/artifact_hash come from the doctor summary (computed read-time from the
 * settings.json bytes, S8a4 §SCOPE-4) and are carried through, reconstructed against grammar.
 */
export function importHookAttestation(doctorAttestation, { expectedPlugins = [] } = {}) {
  const expected = [...new Set(expectedPlugins)].sort();
  if (!isPlainObject(doctorAttestation)) {
    return { ok: false, errors: ['attestation record is not an object'], record: null };
  }
  // Require an ACTUALLY-attested source: a blocked / not-recorded summary is not a claim.
  if (doctorAttestation.attested !== true || doctorAttestation.status !== 'attested') {
    return { ok: false, errors: ['the source attestation is not attested'], record: null };
  }

  const errors = [];
  // A pre-S8a4 attestation carries bundled_plugins but no attested_plugins; the covered set
  // is whichever it recorded.
  const attestedSet = new Set(
    Array.isArray(doctorAttestation.attested_plugins) && doctorAttestation.attested_plugins.length > 0
      ? doctorAttestation.attested_plugins
      : (Array.isArray(doctorAttestation.bundled_plugins) ? doctorAttestation.bundled_plugins : []),
  );
  const uncovered = expected.filter((name) => !attestedSet.has(name));
  if (uncovered.length > 0) {
    errors.push(`the attestation does not cover selected hook plugin(s): ${uncovered.join(', ')}`);
  }

  const canonicalMap = isPlainObject(doctorAttestation.bound_versions?.plugins?.codex) ? doctorAttestation.bound_versions.plugins.codex : {};
  const legacyMap = isPlainObject(doctorAttestation.plugin_versions) ? doctorAttestation.plugin_versions : {};
  const projected = {};
  for (const name of expected) {
    const canonical = matchOr(canonicalMap[name], SEMVER_RE);
    const legacy = matchOr(legacyMap[name], SEMVER_RE);
    // Both maps binding the plugin but DISAGREEING is a corrupt/ambiguous record — refuse,
    // never pick a winner (a silently chosen version is a fabricated claim).
    if (canonical !== null && legacy !== null && canonical !== legacy) {
      errors.push(`${name} has conflicting attested versions (canonical ${canonical} vs legacy ${legacy})`);
      continue;
    }
    const version = canonical ?? legacy;
    if (version === null) {
      errors.push(`${name} is selected but the attestation binds no version for it`);
      continue;
    }
    projected[name] = version;
  }

  if (errors.length > 0) return { ok: false, errors, record: null };

  const record = {
    status: 'attested',
    // The EXACT selected set, so the reducer's set comparison is against the selection.
    attested_plugins: expected,
    bound_versions: {
      // A legacy/unparseable codex version reconstructs to null — importable, never rebound.
      codex: matchOr(doctorAttestation.bound_versions?.codex, SEMVER_RE),
      plugins: { codex: projected },
    },
    artifact_pointer: matchOr(doctorAttestation.artifact_pointer, POINTER_RE),
    artifact_hash: matchOr(doctorAttestation.artifact_hash, SHA256_RE),
    attested_at: matchOr(doctorAttestation.attested_at, TIMESTAMP_RE),
  };
  return { ok: true, errors: [], record };
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * Is an owed CONFIG step resolved? The registry entry is the authority for what its
 * status is ALLOWED to mean; the manifest supplies only the status itself.
 *
 *   * `satisfied` — a post-probe observed it. Always resolves (§6).
 *   * `declined`  — resolves ONLY if the registry says the step is declinable. §6.2's
 *     never-declinable set (host presence/auth, marketplace, runtime, companions, any
 *     hard-edge target) is not a suggestion the manifest can opt out of.
 *   * `not-applicable` — resolves ONLY if the registry says it does not apply. A step
 *     reaching this function is applicable BY CONSTRUCTION (configExpected filters on
 *     it), so the status is a claim contradicting the selection, and it is refused.
 *   * anything else — pending / blocked / manual-follow-up / unknown — does not resolve.
 *
 * `hooks.codex.attested` additionally needs its EVIDENCE, not just its status: the
 * attestation record is what a post-probe observed, so a `satisfied` claim with an
 * absent or stale attestation is a step promoted by assertion (§6: "A step is never
 * satisfied because the operator said so").
 */
function isStepResolved(registryStep, recorded, hookVerdict) {
  const status = recorded?.status;
  if (registryStep.id === stepIds.hooksAttested()) {
    return status === 'satisfied' && hookVerdict.status === 'attested';
  }
  if (status === 'satisfied') return true;
  if (status === 'declined') return registryStep.declinable === true;
  if (status === 'not-applicable') return registryStep.applicable === false;
  return false;
}

/**
 * Reduce a run to its completion state (§8).
 *
 * @param steps   the manifest's steps[] — read for STATE only. Stage, applicability,
 *                declinability and edges come from the registry, because a run file is
 *                operator-editable and a copy that granted itself a stage would be
 *                believed.
 *
 * Returns the §5 `completion` object: { state, unsatisfied, missing_steps, proofs,
 * hook_attestation }.
 */
export function reduceCompletion({
  pluginSet,
  selection,
  steps = [],
  proofs = [],
  hookAttestation = null,
  probe = null,
  runtimeVersion,
  // ADR-0048 §3 — the CURRENT sanitized activation identity (null when no
  // egress activation is configured). Only the egress-provider-ack aggregate
  // consumes it; a pure reducer cannot derive it, so the caller supplies it
  // (bootstrap derives it from the E1 activation checker's sanitized fields).
  currentActivationFingerprint = null,
  // ADR-0048 §3 / D0.1 — the recorded owner receipt testimony, read back from
  // proof/egress-receipt-attestation.json: { record, providerAckSha256 } where
  // providerAckSha256 is the stored egress-provider-ack FILE's own sha256 (the
  // write-time hash re-derived at read-back). Null when no testimony exists.
  receiptEvidence = null,
}) {
  const stateById = new Map(steps.filter((s) => typeof s?.id === 'string').map((s) => [s.id, s]));
  const fragmentApplied = {};
  for (const host of ['claude', 'codex']) {
    fragmentApplied[host] = stateById.get(stepIds.permissionApplied(host))?.fragment_applied === true;
  }
  // The egress-proof opt-in derives from the run's own steps[] the same
  // manifest-legitimate way fragment_applied does (D0.2): once the step was
  // recorded expected, it stays expected here.
  const egressProofRequested = stateById.has(stepIds.proofEgressProviderAck());

  const expected = deriveExpectedSteps({ pluginSet, selection, permissionFragmentApplied: fragmentApplied, egressProofRequested });
  const owed = expectedStepIds(expected);
  const current = currentBoundVersions({ probe, selection, runtimeVersion });
  const requiredPlugins = requiredBoundPlugins({ pluginSet, selection });

  // MISSING = an owed CONFIG step with no entry in steps[]. CONFIG-only, deliberately
  // (§8): counting an omitted PROOF step here would force `incomplete` and make
  // `configured-not-verified` unreachable all over again — an absent proof is already
  // handled by the proof clause, which is what that terminal state IS.
  const configExpected = expected.filter((s) => s.applicable && CONFIG_STAGES.includes(s.stage));
  const missing_steps = configExpected.filter((s) => !stateById.has(s.id)).map((s) => s.id).sort();

  const codexHookPluginsEarly = [...new Set(selection.plugins ?? [])].filter((n) => pluginSet.plugins?.[n]?.hook_bearing?.codex === true).sort();
  const hookStep = expected.find((s) => s.id === stepIds.hooksAttested());
  const hookVerdict = recomputeHookAttestation(hookAttestation, {
    current,
    expectedPlugins: codexHookPluginsEarly,
    probe,
    applicable: hookStep?.applicable === true,
  });

  // UNSATISFIED = an owed CONFIG step present but not resolved. The status is judged
  // AGAINST THE REGISTRY, not taken at face value — which is the whole point of having
  // derived the registry in the first place. Reading `RESOLVED_STEP_STATUSES.includes()`
  // alone let a manifest write `declined` on `host.codex.present` (declinable: false in
  // the registry) and reach `complete` on a machine with no Codex CLI at all.
  const unsatisfied = configExpected
    .filter((s) => stateById.has(s.id) && !isStepResolved(s, stateById.get(s.id), hookVerdict))
    .map((s) => s.id)
    .sort();

  // PROOFS — every applicable Stage-8 step, evaluated from evidence.
  //
  // Duplicate evidence is REJECTED, never chosen between (ADR-0048 §3): the
  // pre-1.2 `new Map(...)` collapse silently let the LAST record of a
  // duplicated kind win — a forged second record could shadow a real failure.
  // The read boundary (readBootstrapProofRecords) already refuses duplicates
  // all-or-nothing; this is the defense-in-depth for direct library callers.
  // Neither record of a duplicated kind is trusted, and the run can never
  // reduce past `incomplete` while duplicate evidence exists — independently
  // of whether the duplicated proof is required (a duplicated non-required
  // proof is still an evidence-integrity violation, not a pass).
  const plainProofs = proofs.filter((p) => isPlainObject(p));
  const kindCounts = new Map();
  for (const p of plainProofs) kindCounts.set(p.kind, (kindCounts.get(p.kind) ?? 0) + 1);
  const duplicatedKinds = [...kindCounts.entries()].filter(([, count]) => count > 1).map(([kind]) => kind).sort();
  const proofByKind = new Map(plainProofs.filter((p) => !duplicatedKinds.includes(p.kind)).map((p) => [p.kind, p]));
  const proofSteps = expected.filter((s) => PROOF_STAGES.includes(s.stage));
  const evaluatedProofs = proofSteps.map((step) => {
    const kind = step.id.replace(/^proof\./, '');
    const declined = stateById.get(step.id)?.status === 'declined';
    if (duplicatedKinds.includes(kind)) {
      return {
        kind,
        step_id: step.id,
        declined,
        status: 'failed',
        reasons: [`${kindCounts.get(kind)} evidence records claim kind "${kind}" — duplicate evidence is rejected, not chosen between (ADR-0048 §3)`],
        required: step.applicable,
        artifact_pointer: null,
        artifact_hash: null,
        bound_versions: null,
        ran_at: null,
      };
    }
    const record = proofByKind.get(kind) ?? null;
    const verdict = recomputeProofStatus(record, { current, applicable: step.applicable, requiredPlugins, currentActivationFingerprint });
    return {
      kind,
      step_id: step.id,
      declined,
      // The RECOMPUTED aggregate — the stored status is not consulted.
      status: verdict.status,
      reasons: verdict.reasons,
      required: step.applicable,
      artifact_pointer: record?.artifact_pointer ?? null,
      artifact_hash: record?.artifact_hash ?? null,
      bound_versions: record?.bound_versions ?? null,
      ran_at: record?.ran_at ?? null,
    };
  });

  // §8's formula, in the order it is written there.
  const configResolved = missing_steps.length === 0 && unsatisfied.length === 0;
  // A DECLINED proof caps at configured-not-verified and never grants complete (§6.2)
  // — so it is "not passed" here, not an excuse.
  const requiredProofs = evaluatedProofs.filter((p) => p.required);
  const everyProofPassed = requiredProofs.every((p) => p.status === 'passed' && !p.declined);

  // Duplicate evidence caps at `incomplete` regardless of the formula above —
  // the integrity of the evidence set failed, so no terminal claim stands
  // (§8 amendment, ADR-0048 §3).
  const state = duplicatedKinds.length > 0
    ? 'incomplete'
    : !configResolved
      ? 'incomplete'
      : everyProofPassed
        ? 'complete'
        : 'configured-not-verified';

  // ADR-0048 §3 / D0.1 — the receipt verdict rides completion ONLY when the
  // run has anything to say about it (testimony recorded, or the egress proof
  // opted in). A run outside that world keeps the exact 1.1 completion shape —
  // the member is schema-optional precisely so absence stays representable.
  const egressStep = proofSteps.find((s) => s.id === stepIds.proofEgressProviderAck());
  const egressEval = evaluatedProofs.find((p) => p.kind === 'egress-provider-ack');
  const egressAckRecord = proofByKind.get('egress-provider-ack') ?? null;
  const receiptVerdict = (receiptEvidence?.record || egressStep?.applicable === true)
    ? recomputeReceiptAttestation({
        record: receiptEvidence?.record ?? null,
        providerAckSha256: receiptEvidence?.providerAckSha256 ?? null,
        providerAckAttemptHash: egressAckRecord?.provider_ack?.attempt_hash ?? null,
        ackStatus: egressEval?.status ?? 'absent',
        applicable: egressStep?.applicable === true || Boolean(receiptEvidence?.record),
      })
    : null;

  return {
    state,
    unsatisfied,
    missing_steps,
    proofs: evaluatedProofs,
    hook_attestation: {
      status: hookVerdict.status,
      reasons: hookVerdict.reasons,
      attested_plugins: hookAttestation?.attested_plugins ?? [],
      bound_versions: hookAttestation?.bound_versions ?? null,
      artifact_pointer: hookAttestation?.artifact_pointer ?? null,
      artifact_hash: hookAttestation?.artifact_hash ?? null,
      attested_at: hookAttestation?.attested_at ?? null,
    },
    ...(receiptVerdict ? { egress_receipt_attestation: receiptVerdict } : {}),
  };
}
