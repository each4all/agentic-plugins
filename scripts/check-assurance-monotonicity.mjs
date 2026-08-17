#!/usr/bin/env node
// scripts/check-assurance-monotonicity.mjs
//
// ADR-0054 §Decision 8 — revocation is irreversible BY RELEASE HISTORY, and
// this is the check that makes it so.
//
// WHY A SECOND CHECK EXISTS BESIDE check-release-obligation.mjs. That one
// proves BYTE PROMOTION: the protected tree at HEAD must match the tree the
// newest reachable tag ships. It says so explicitly — "Rolling a protected
// asset back is legitimate; ... The rollback path is a forward patch carrying
// the restored bytes." Which means a forward patch that DELETES a revocation
// record satisfies it completely: the bytes are promoted, and the meaning is
// reversed. Byte promotion is not irreversible meaning, and ADR-0053
// §Decision 8's "rolling back a package does not resurrect withdrawn coverage"
// is a statement about meaning.
//
// The authority this check uses was itself a refuted assumption, recorded in
// ADR-0054 rather than dropped: the working position was that non-resurrection
// could not be enforced at all, because the only durable stores runtime writes
// (`.agentic-plugins/state/`, `~/.agentic-plugins`) vanish on a fresh clone and
// can be deleted by the operator. That reasoning only considered stores runtime
// WRITES. The packaged baseline is versioned in git and released as tags, so
// the release history is a monotonic authority no operator action on one
// machine can rewrite — and nothing here reads machine state.
//
// WHAT IT ENFORCES, over every reachable `plugin-runtime-v*` tag and the target
// ref:
//
//   1. NO DISAPPEARANCE. A grant id observed at any earlier release must still
//      be present. Removing a positive grant outright is what §Decision 8
//      refuses; the permitted form is leaving the tombstone and changing state.
//   2. TERMINAL STATES ABSORB. `granted` may become `revoked` or `superseded`.
//      Nothing may become `granted`, and a tombstone may not be re-labelled as
//      the other kind of tombstone.
//   3. CONTENT IMMUTABILITY. For one id, everything except `state` is
//      immutable. A grant whose cohort, packages, residuals or provenance can
//      be edited in place is not an immutable identity, and the whole
//      re-approval mechanism (a NEW id carrying `reapproval_of`) exists only
//      because editing is forbidden.
//
// NO BYPASS FLAG, and that is deliberate rather than an omission. A violation
// here means released meaning was mutated, which the record's own design says
// cannot happen; the remedy is not to wave it through but to decide
// deliberately what the repository does about an integrity failure it declared
// impossible. `check-release-obligation.mjs` needed an ADOPTION_EPOCH because
// it inherited 47 pre-existing violations; this check inherits ZERO by
// construction — the assurance section lands in R1 and no released tag carries
// one — so an epoch here would grandfather nothing and only supply a lever.
//
// Reads git and the working tree's packaged schema. Never writes.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  ASSURANCE_SCHEMA_FAMILY,
  parseAssuranceSection,
} from '../plugins/runtime/scripts/lib/host-parity-baseline.mjs';
import { loadSchema } from '../plugins/runtime/scripts/lib/schema-validate.mjs';

export const BASELINE_PATH = 'plugins/runtime/docs/host-parity-baseline.md';
export const TAG_PREFIX = 'plugin-runtime-v';
export const RUNTIME_PACKAGE = 'plugins/runtime';

// Same strictness as check-release-obligation.mjs, for the same reason: a
// permissive pattern lets two spellings of one version compare equal and makes
// the ordering depend on enumeration order.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `granted` may reach these; a terminal state may reach only itself. */
const ALLOWED_TRANSITIONS = Object.freeze({
  granted: Object.freeze(['granted', 'revoked', 'superseded']),
  revoked: Object.freeze(['revoked']),
  superseded: Object.freeze(['superseded']),
});

/**
 * Which states may follow this one — FAIL-CLOSED on a state the table does not
 * know.
 *
 * `ALLOWED_TRANSITIONS[state]?.includes(next)` reads correctly and is wrong for
 * the case that matters: an unrecognised state yields `undefined`, whose
 * optional-chained `includes` is `undefined`, and a truthiness test on that
 * reports "no violation". A record whose state this gate cannot classify must
 * be a violation, not a pass — an assurance enum widened in a later schema
 * minor would otherwise walk straight through the only check that guards
 * released meaning.
 */
function permittedFrom(state) {
  return ALLOWED_TRANSITIONS[state] ?? [];
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function parseSemver(value) {
  const match = SEMVER.exec(value ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Reachable runtime tags, oldest first.
 *
 * `--merged <ref>` rather than every tag in the repository: a tag on an
 * abandoned branch describes a release this ref's history does not contain, and
 * holding a ref to a lineage it never had is a demand that cannot be met.
 */
export function reachableRuntimeTags(repoRoot, ref) {
  const names = git(repoRoot, ['tag', '--list', `${TAG_PREFIX}*`, '--merged', ref])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return names
    .map((name) => ({ name, version: parseSemver(name.slice(TAG_PREFIX.length)) }))
    .filter((tag) => tag.version !== null)
    .sort((a, b) => compareSemver(a.version, b.version));
}

/**
 * The baseline text at a ref, or `null` when the ref carries no such file.
 *
 * A missing file is not an error: the packaged baseline postdates the earliest
 * runtime tags, and a check that refused to read history older than the asset
 * would have no history to read.
 */
function baselineAt(repoRoot, ref) {
  try {
    // stderr PIPED rather than inherited: this probe is expected to fail for
    // every tag older than the asset, and `git show`'s "exists on disk, but not
    // in <tag>" would otherwise print once per tag — 70-odd lines of noise
    // ahead of the one line that is the verdict.
    return execFileSync('git', ['-C', repoRoot, 'show', `${ref}:${BASELINE_PATH}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/**
 * Everything about one grant except its state, serialized deterministically.
 *
 * Key-sorted rather than schema-ordered: both sides of every comparison go
 * through this one function, so any total order works, and depending on the
 * packaged schema's property order would make a schema reflow read as a content
 * mutation of every historical grant.
 */
function grantIdentity(grant) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
  };
  const { state, ...rest } = grant;
  return JSON.stringify(stable(rest));
}

/**
 * Read the grant set at one ref. Returns
 * `{ ref, label, status, grants }` or throws for a status that means the check
 * cannot see what it must see.
 *
 * `absent` is the ONLY non-`resolved` status accepted, and only because it is
 * the honest reading of history predating the record. Every other status
 * (`ambiguous`, `unparseable`, `invalid`, `noncanonical`, `unknown-schema`) is
 * fatal: an unreadable record at any point in the window means the monotonicity
 * question has no answer, and answering it anyway from the refs that did parse
 * is the fail-open direction.
 */
export function grantsAt(repoRoot, ref, { label = ref, schema }) {
  const text = baselineAt(repoRoot, ref);
  if (text === null) return { ref, label, status: 'no-baseline', grants: [] };
  const parsed = parseAssuranceSection(text, { schema });
  if (parsed.status === 'absent') return { ref, label, status: 'absent', grants: [] };
  if (parsed.status !== 'resolved') {
    const err = new Error(
      `the assurance record at ${label} reads "${parsed.status}" — monotonicity cannot be proven across a record this reader cannot parse`
      + (parsed.findings?.length ? `\n  ${parsed.findings.join('\n  ')}` : ''),
    );
    err.code = 'UNREADABLE_RECORD';
    throw err;
  }
  const grants = parsed.record.grants ?? [];
  // DUPLICATE IDS fail closed here, because every structure below is keyed by id
  // and cross-host review measured the consequence: `[A, A]` certified as
  // monotonic with `grants_tracked=1` and `target_grants=2`, the two counts
  // silently disagreeing because one map was first-wins and the other last-wins.
  // The runtime matcher rejects such a record, so this was the semantic gate
  // certifying something the runtime would refuse.
  //
  // Only THIS rule is applied, not the whole semantic contract. Running
  // `assuranceRecordIssues` over released history would mean that any future
  // tightening of a coherence rule retroactively condemns tags already shipped,
  // with no remedy — the one class of red this repository treats as a dead end
  // rather than a signal. Duplicate ids are different: they are not a policy
  // judgement but a precondition for this gate to be able to reason at all.
  const seen = new Set();
  const duplicates = [];
  for (const grant of grants) {
    if (seen.has(grant?.id)) duplicates.push(grant.id);
    seen.add(grant?.id);
  }
  if (duplicates.length > 0) {
    const err = new Error(
      `the assurance record at ${label} declares duplicate grant id(s) ${[...new Set(duplicates)].map((id) => `"${id}"`).join(', ')}`
      + ' — monotonicity is keyed by id, so a record with two of one id cannot be checked',
    );
    err.code = 'DUPLICATE_GRANT_ID';
    throw err;
  }
  return { ref, label, status: 'resolved', grants };
}

/**
 * Compare the target ref's grant set against the accumulated history.
 *
 * Every historical observation is compared against the TARGET, not against its
 * neighbour. Neighbour-wise comparison would miss a delete-then-restore across
 * two releases, which is the exact shape a forward patch takes.
 */
export function violations({ history, target }) {
  const found = [];

  // ONE TIMELINE PER ID, over history AND the target in order.
  //
  // The first version compared each historical observation against the TARGET
  // only, and cross-host review measured two launderings that shape cannot see:
  //
  //   v1 [A] -> v2 [] -> v3 [A unchanged] -> HEAD [A unchanged]      => clean
  //   v1 [A cohort X] -> v2 [A cohort Y] -> v3 [A cohort X] -> HEAD  => clean
  //
  // Both shipped a release in which the record's meaning was different, and both
  // ended at a target that agrees with the start. A target-only comparison is
  // structurally unable to report them, because nothing about HEAD is wrong.
  // Walking the sequence is what makes "never disappears" and "contents are
  // immutable" statements about HISTORY rather than about the current tree.
  //
  // ⚠ THE COST IS STATED: a violation in released history is not repairable by
  // editing, so this gate stays red until the repository decides what to do about
  // it. That is deliberate and it is the house posture — the doc-freshness gate
  // documents the same thing ("that red is the honest signal, not a defect to
  // automate away"). It is affordable here because the corpus starts EMPTY: no
  // released tag carries a record, so nothing is inherited and every future entry
  // arrives through a CI run that would have caught it.
  const timelines = new Map();
  const sequence = [...history, target];
  for (const state of sequence) {
    for (const grant of state.grants) {
      if (!timelines.has(grant.id)) timelines.set(grant.id, []);
      timelines.get(grant.id).push({ grant, label: state.label });
    }
  }

  const labelIndex = new Map(sequence.map((state, index) => [state.label, index]));
  for (const [id, observations] of timelines) {
    const first = observations[0];

    // (1) ABSENCE between two presences. A grant that vanished for one release
    // and came back is a release in which it was gone, whatever the target says.
    const presentAt = new Set(observations.map((observation) => labelIndex.get(observation.label)));
    const firstIndex = labelIndex.get(first.label);
    const lastIndex = labelIndex.get(observations[observations.length - 1].label);
    for (let index = firstIndex + 1; index <= lastIndex; index += 1) {
      if (presentAt.has(index)) continue;
      found.push({
        kind: 'disappeared',
        id,
        detail: `present at ${first.label} and absent at ${sequence[index].label} — removing a grant leaves no tombstone, and ADR-0054 §Decision 8 requires one`,
      });
      break;
    }
    // Absent from the TARGET is the same violation, reported with the target's
    // name because that is the one an author can still fix.
    if (lastIndex !== labelIndex.get(target.label)) {
      found.push({
        kind: 'disappeared',
        id,
        detail: `present at ${observations[observations.length - 1].label} and absent at ${target.label} — removing a grant leaves no tombstone, and ADR-0054 §Decision 8 requires one`,
      });
    }

    // (2) STATE TRANSITIONS, pairwise along the timeline.
    for (let i = 1; i < observations.length; i += 1) {
      const from = observations[i - 1];
      const to = observations[i];
      if (permittedFrom(from.grant.state).includes(to.grant.state)) continue;
      found.push({
        kind: labelIndex.get(to.label) === labelIndex.get(target.label) ? 'transition' : 'historical-transition',
        id,
        detail: `state went "${from.grant.state}" (${from.label}) -> "${to.grant.state}" (${to.label}) — a terminal state absorbs, and nothing returns to granted`,
      });
    }

    // (3) CONTENT, every observation against the FIRST one. Anchoring on the
    // first is what catches an edit that travelled with a legal state transition
    // and was then carried forward — a neighbour-wise comparison sees the
    // carry-forward as clean, and a target-only comparison sees a reverted edit
    // as clean.
    const baseline = grantIdentity(first.grant);
    for (const observation of observations.slice(1)) {
      if (grantIdentity(observation.grant) === baseline) continue;
      found.push({
        kind: 'mutated',
        id,
        detail: `content other than \`state\` differs at ${observation.label} from ${first.label} — grant contents are immutable; a changed review is a NEW id carrying reapproval_of`,
      });
      break;
    }
  }

  return found;
}

export function classify(repoRoot, { ref = 'HEAD' } = {}) {
  const shallow = git(repoRoot, ['rev-parse', '--is-shallow-repository']).trim();
  if (shallow === 'true') {
    return {
      status: 'indeterminate',
      reason: 'shallow_clone',
      summary: 'the repository is a shallow clone, so reachable release tags cannot be enumerated — this gate needs full history (fetch-depth: 0)',
    };
  }
  return { status: 'ready', ref };
}

export async function run({ repoRoot, ref = 'HEAD' } = {}) {
  const ready = classify(repoRoot, { ref });
  if (ready.status !== 'ready') return { ...ready, ok: false };

  const schema = await loadSchema(ASSURANCE_SCHEMA_FAMILY, { pluginRoot: resolve(repoRoot, RUNTIME_PACKAGE) });
  const tags = reachableRuntimeTags(repoRoot, ref);
  // ZERO reachable tags is INDETERMINATE, not monotonic. With no release history
  // there is nothing to compare against, and reporting the strongest possible
  // verdict from the weakest possible evidence is how a gate stops meaning
  // anything. It also covers the case a shallow-clone check misses — a full clone
  // whose tags were never fetched (`git fetch` without `--tags`) — which
  // cross-host review named as the remaining authority gap.
  if (tags.length === 0) {
    return {
      ok: false,
      status: 'indeterminate',
      reason: 'no_release_tags',
      summary: `no reachable ${TAG_PREFIX}* tags from ${ref} — release history is this gate's only authority, and it cannot be read`,
      ref,
      tags_examined: 0,
    };
  }
  const history = [];
  for (const tag of tags) {
    history.push(grantsAt(repoRoot, tag.name, { label: tag.name, schema }));
  }
  const target = grantsAt(repoRoot, ref, { label: `${ref} (working ref)`, schema });
  const found = violations({ history, target });

  return {
    ok: found.length === 0,
    status: found.length === 0 ? 'monotonic' : 'violated',
    ref,
    // Reported rather than assumed. A green run over zero tracked grants proves
    // nothing about the rules, and printing the corpus size is what keeps that
    // visible instead of reading as coverage it does not have.
    tags_examined: tags.length,
    tags_with_record: history.filter((state) => state.status === 'resolved').length,
    grants_tracked: new Set(history.flatMap((state) => state.grants.map((grant) => grant.id))).size,
    target_grants: target.grants.length,
    violations: found,
  };
}

/**
 * The CLI body, RETURNING an exit code rather than calling `process.exit`.
 *
 * Extracted because cross-host review found the one mutation the tests did not
 * catch: deleting the `process.exit(1)` left all 30 monotonicity tests green. The
 * test that claimed to cover it built a violating fixture and then invoked the
 * clean real repository, so it asserted exit 0 and proved nothing about the
 * failing path. An injectable body is testable against a violating fixture; a
 * bare top-level block is not.
 *
 * `log`/`logError` are injected for the same reason — the remedy text is part of
 * the contract, and a test that cannot read it cannot check it.
 */
export async function main({ repoRoot, ref = 'HEAD', log = console.log, logError = console.error } = {}) {
  let result;
  try {
    result = await run({ repoRoot, ref });
  } catch (err) {
    logError(`✗ assurance-monotonicity: ${err.message}`);
    return 1;
  }
  if (!result.ok && result.status === 'indeterminate') {
    logError(`✗ assurance-monotonicity: ${result.reason}`);
    logError(`  ${result.summary}`);
    return 1;
  }
  if (!result.ok) {
    logError(`✗ assurance-monotonicity: ${result.violations.length} violation(s) at ${result.ref}`);
    for (const violation of result.violations) {
      logError(`  · [${violation.kind}] grant "${violation.id}": ${violation.detail}`);
    }
    logError('  Remedy: restore the removed record, or express the change as a NEW grant id');
    logError('  carrying `reapproval_of` (ADR-0054 §Decision 8). Released meaning is not editable.');
    return 1;
  }
  log(
    `✓ assurance-monotonicity: ${result.status} at ${result.ref} `
    + `(tags=${result.tags_examined}, tags_with_record=${result.tags_with_record}, `
    + `grants_tracked=${result.grants_tracked}, target_grants=${result.target_grants})`,
  );
  return 0;
}

const invokedAsCLI = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedAsCLI) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const refArg = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  process.exit(await main({ repoRoot, ref: refArg ?? 'HEAD' }));
}
