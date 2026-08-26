// plugins/runtime/scripts/lib/answer-values.mjs
//
// THE VALUE GRAMMAR (machine-bootstrap-contract.md §3.3) — the `set:<payload>`
// answer, its per-step key sets, and the fold that turns a run's `choices[]`
// ledger into the operator's STANDING decision per step.
//
// WHY A SEPARATE ANSWER VERB. The four bare answers (`decline`/`accept`/
// `execute`/`attest-receipt`) all say something ABOUT a step without carrying a
// value. Two Stage-4 config steps need the operator to CHOOSE one, and the
// choice has to survive in a form a replay can read back. Three shapes were
// available and two are unsafe:
//
//   * a sibling `choices[].value` field — REJECTED. lib/schema-validate.mjs
//     forgives an unknown SCALAR key when the document declares a newer schema
//     minor, so a 1.2 reader meeting a 1.3 run would emit
//     `unknown-scalar-key-ignored`, drop the value, and read the row's
//     `answer: "accept"` as a bare accept. The ledger would then say the
//     operator approved something, without saying what.
//   * reusing `accept` with the value elsewhere — REJECTED for the same reason
//     plus one more: an older runtime would half-recognize it. `set:` fails
//     `ANSWER_VALUES.includes()` outright, so an old reader REFUSES (exit 40)
//     instead of misreading. Loud beats lossy.
//   * one atomic `set:<payload>` string — TAKEN. `choices[].answer` is already
//     `type:[string,null], maxLength:1024`, so the run schema's JSON SHAPE does
//     not change at all; the 1.2 → 1.3 minor bump exists purely to arm the
//     future-minor resume/seed fence, which is what stops an older MUTATOR from
//     closing a run under expectations it cannot see.
//
// WHY THE STANDING VALUE IS FOLDED FROM `choices[]` AND NOT HELD IN
// `step.desired`. `desired` was the obvious seat and is wrong: `invalidateStaleSteps`
// clears it on ANY version drift — for satisfied, manual-follow-up and pending
// rows alike — so a routine runtime patch bump would silently discard the
// operator's decision. That function's own comment states the principle this
// module follows instead: "a `declined` is an operator CHOICE recorded in
// choices[], not an observation". A drift invalidates observations and rendered
// plans; it never invalidates a decision. `egressProofOptedIn` already reads the
// ledger for exactly this class of question.

import {
  CONFIG_KEY_FAMILIES,
  CONFIG_KEY_VALIDATORS,
  ENTRY_BRIEF_EMPTY_MODES,
  ENTRY_BRIEF_MODES,
  NOTIFY_KEY_DEFAULTS,
  SESSION_CAPTURE_MODES,
  SESSION_KEY_DEFAULTS,
  USER_SCOPE_ONLY_CONFIG_KEYS,
} from './runtime-config.mjs';
import { NOTIFY_KINDS, parseKindsFilter } from './notify-schema.mjs';
import { stepIds } from './step-registry.mjs';

// The answer prefix. One place spells it, so a parser and an emitter cannot
// drift into disagreement (the `stepIds` rule, applied to the answer vocabulary).
export const SET_ANSWER_PREFIX = 'set:';

// The per-key token meaning "leave this key UNWRITTEN; the shipped default
// stands, deliberately".
//
// It is a DECISION, not an absence, and that distinction is the whole reason it
// exists. §6.1.1 says a default is not a decision — and it is talking about
// CONFIGURATION. Here the decision lives in `choices[]` (the ledger row IS the
// decision) and the observation merely confirms the machine matches it, exactly
// as `model_effort_fallback = "host-native"` is a positively recorded posture
// rather than an inferred one.
//
// Its per-key MEANING comes from the key's own contract, never from this module:
// for the session keys `SESSION_KEY_DEFAULTS` gives a concrete shipped default,
// so unset resolves to a definite posture; for `notify_kinds` unset means
// future-open ALL kinds (`parseKindsFilter` returns `kinds: null`), which is why
// it can never be spelled as an enumeration — see the all-kinds refusal below.
export const UNSET = 'unset';

// A future notify kind literally named `unset` would collide with the token
// above and silently turn "leave the filter open" into "filter to the unset
// kind". Cheap to assert, impossible to notice otherwise.
if (NOTIFY_KINDS.includes(UNSET)) {
  throw new Error(`notify kind "${UNSET}" collides with the value-grammar unset token; rename the kind or the token before shipping`);
}

/**
 * The VALUE-BEARING steps and the config keys each one owns.
 *
 * Both are Stage 4 (`appliedByFor` maps stage 4 to `agentic-config`) because the
 * thing that writes them is `runtime:settings --apply --target user`, not an
 * operator editing a host file — which is what Stage 5 means. `config.model_effort`
 * is the precedent for a Stage-4 step that asks for a recorded decision about
 * agentic-plugins' own config.
 *
 * Key sets are READ from `CONFIG_KEY_FAMILIES`, never re-enumerated: the family
 * list is what auto-generates the settings CLI flags, so a key added there joins
 * this interview automatically instead of quietly falling out of it.
 */
export const VALUE_STEPS = Object.freeze({
  [stepIds.configSession()]: Object.freeze({
    keys: Object.freeze([...CONFIG_KEY_FAMILIES.session]),
    // §4.4 — what a value key is judged against. `user` means the persisted
    // user-global posture in ~/.agentic-plugins/config.toml, which is the ONLY
    // layer bootstrap reads (§1.1 keeps it off the repo-scoped seam).
    scope: 'user',
  }),
  [stepIds.configNotifyKinds()]: Object.freeze({
    keys: Object.freeze(['notify_kinds']),
    scope: 'user',
  }),
});

export function isValueStep(stepId) {
  return Object.hasOwn(VALUE_STEPS, stepId);
}

export function valueStepKeys(stepId) {
  return VALUE_STEPS[stepId]?.keys ?? null;
}

/**
 * Split a raw answer into its kind. Returns `{ kind: 'bare' }` for the four
 * closed-set answers and `{ kind: 'set', payload }` for the value form.
 *
 * A PREDICATE, not a list membership — which is why `ANSWER_VALUES` keeps
 * naming exactly the bare four rather than growing an open prefix family that a
 * membership test could never express.
 */
export function classifyAnswer(answer) {
  if (typeof answer !== 'string') return { kind: 'invalid', payload: null };
  if (answer.startsWith(SET_ANSWER_PREFIX)) {
    return { kind: 'set', payload: answer.slice(SET_ANSWER_PREFIX.length) };
  }
  return { kind: 'bare', payload: null };
}

// The value-side cap. `choices[].answer` is capped at 1024 by the run schema;
// this is the same bound applied BEFORE any parsing effect, so an oversized
// payload is refused rather than parsed and then rejected at persist time
// (a resume can run a proof executor before the manifest validates, so "refused
// late" is not the same as "refused").
export const SET_PAYLOAD_MAX = 1024;

/**
 * Parse one `set:` payload for one step. ATOMIC: any defect rejects the WHOLE
 * row rather than the offending member.
 *
 * Atomicity is load-bearing rather than tidy. A payload is documented
 * order-independent, so accepting the good members of
 * `entry_brief=off;entry_brief=startup` would make the result depend on member
 * order — the exact property the `key=value` shape was chosen to remove.
 *
 * Grammar: `<key>=<value>[;<key>=<value>]...`
 *
 * `;` separates pairs and `=` separates key from value. The separator is NOT a
 * comma, and that is not cosmetic: `notify_kinds`' own value IS a comma-separated
 * kind list, so a comma-separated pair list could not be parsed unambiguously.
 *
 * Returns `{ ok, decisions: Map<key, value|UNSET>, errors: string[] }`. Error
 * strings never quote a value that FAILED its check (D1 §3.2 — a failed value is
 * unclamped operator input by definition); a key that MATCHED is a name this
 * runtime declared, so it keeps being named.
 */
export function parseSetPayload(stepId, payload) {
  const keys = valueStepKeys(stepId);
  if (!keys) {
    return { ok: false, decisions: new Map(), errors: [`step ${stepId} does not accept a value answer`] };
  }
  if (typeof payload !== 'string' || payload.length === 0) {
    return { ok: false, decisions: new Map(), errors: [`step ${stepId}: the set: answer carries an empty payload; give ${keys.map((k) => `${k}=<value|${UNSET}>`).join(';')}`] };
  }
  if (payload.length > SET_PAYLOAD_MAX) {
    return { ok: false, decisions: new Map(), errors: [`step ${stepId}: the set: payload exceeds ${SET_PAYLOAD_MAX} characters; the value is withheld because an over-long payload is unclamped input`] };
  }

  const decisions = new Map();
  const errors = [];
  const members = payload.split(';');
  for (const member of members) {
    if (member.length === 0) {
      errors.push(`step ${stepId}: the set: payload has an empty member (a stray ';')`);
      continue;
    }
    const eq = member.indexOf('=');
    if (eq <= 0) {
      errors.push(`step ${stepId}: every set: member must be <key>=<value>; one member is not`);
      continue;
    }
    const key = member.slice(0, eq);
    const raw = member.slice(eq + 1);
    if (!keys.includes(key)) {
      // The key is named: it either matched a declared key (safe to echo) or it
      // did not, in which case naming the EXPECTED set is what makes the error
      // actionable while echoing nothing the operator typed.
      errors.push(`step ${stepId}: unknown key in the set: payload — expected one of ${keys.join(', ')}`);
      continue;
    }
    if (decisions.has(key)) {
      errors.push(`step ${stepId}: key ${key} appears twice in one set: payload; an order-independent payload cannot carry two answers for one key`);
      continue;
    }
    if (raw === UNSET) {
      decisions.set(key, UNSET);
      continue;
    }
    const verdict = validateValueForKey(key, raw);
    if (!verdict.ok) {
      errors.push(`step ${stepId}: ${key} — ${verdict.reason}`);
      continue;
    }
    decisions.set(key, verdict.normalized);
  }

  if (errors.length > 0) return { ok: false, decisions: new Map(), errors };
  return { ok: true, decisions, errors: [] };
}

/**
 * Per-key value validation. Every rule delegates to the key's EXISTING validator
 * — `CONFIG_KEY_VALIDATORS` for the session enums, `parseKindsFilter` for the
 * kind set — so no enum is re-enumerated here and a key whose domain changes
 * changes in exactly one place.
 *
 * `notify_kinds` carries two extra refusals that exist only in the interview,
 * because both are shapes the settings CLI legitimately accepts but that an
 * interview must not RECOMMEND:
 *
 *   * the ALL-KINDS enumeration. It is indistinguishable from `unset` today and
 *     diverges only in the future, where it silently drops a kind this runtime
 *     has not shipped yet — and `runtime:settings --unset` is the only way back,
 *     so the divergence is a decision the operator never revisits. The refusal
 *     names `unset` as the thing meant. `runtime:settings --notify-kinds` stays
 *     open for an operator who wants the frozen enumeration deliberately; this
 *     is the interview declining to propose a trap, not a capability removal.
 *   * the BLANK csv. `parseKindsFilter('')` returns `kinds: null`, so it behaves
 *     exactly as unset while writing a byte that LOOKS like a filter. Same
 *     remedy, different disguise.
 *
 * Comparison is by SET semantics after `parseKindsFilter` has trimmed and
 * de-duplicated, so neither ordering nor a repeated token can walk an all-kinds
 * payload past the refusal.
 */
export function validateValueForKey(key, raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'the value is not a string' };
  if (key === 'notify_kinds') {
    const parsed = parseKindsFilter(raw);
    if (!parsed.ok) {
      // parseKindsFilter quotes the unknown token; the answers boundary must not
      // (D1 §3.2). Report the closed set instead and let the operator compare.
      return { ok: false, reason: `not a valid kind list — the value is withheld because it did not parse; valid kinds are ${NOTIFY_KINDS.join(', ')}` };
    }
    if (parsed.kinds === null) {
      return { ok: false, reason: `an empty kind list means "no filter", which is the same posture as ${UNSET} but written as a byte that looks like a filter; answer ${key}=${UNSET} instead` };
    }
    if (parsed.kinds.size === NOTIFY_KINDS.length) {
      return { ok: false, reason: `enumerating every kind this runtime knows is indistinguishable from ${UNSET} today and permanently narrower tomorrow — a kind added later would be filtered out, and only \`runtime:settings --unset ${key}\` undoes it; answer ${key}=${UNSET} to stay future-open` };
    }
    // NORMALIZED to the parser's own set, sorted — so two payloads that differ
    // only in order or repetition fold to one standing decision and a re-answer
    // that changes nothing is recognizable as changing nothing.
    return { ok: true, normalized: [...parsed.kinds].sort().join(',') };
  }
  const validator = CONFIG_KEY_VALIDATORS[key];
  if (typeof validator !== 'function') {
    return { ok: false, reason: 'this runtime has no validator for the key, so it cannot accept a value for it' };
  }
  try {
    validator(raw, key);
  } catch (err) {
    // The validator's message names the LEGAL set, not the rejected value.
    return { ok: false, reason: err?.message ?? 'the value failed its validator' };
  }
  return { ok: true, normalized: raw };
}

/**
 * ADR-0047 §8 — the dual-kind transition window. Returns a warning string when a
 * standing kind filter names exactly ONE of `turn-complete` / `response-needed`,
 * or null otherwise.
 *
 * A WARNING and not a refusal, deliberately. §8 step 2 opens the window with both
 * kinds (or unset) and §8 step 5 explicitly permits narrowing to one AFTER both
 * producers are verified upgraded — so a hard refusal would block a legitimate
 * post-window narrowing. The warning names the verification the narrowing
 * presupposes rather than assuming the operator has not done it.
 *
 * XOR, not "contains one of": naming both is the window being open, which is the
 * state §8 asks for.
 */
export const DUAL_KIND_PAIR = Object.freeze(['turn-complete', 'response-needed']);

export function dualKindWarning(csv) {
  if (typeof csv !== 'string' || csv.length === 0) return null;
  const parsed = parseKindsFilter(csv);
  if (!parsed.ok || parsed.kinds === null) return null;
  const present = DUAL_KIND_PAIR.filter((kind) => parsed.kinds.has(kind));
  if (present.length !== 1) return null;
  const absent = DUAL_KIND_PAIR.find((kind) => !parsed.kinds.has(kind));
  return `notify_kinds names ${present[0]} but not ${absent} — ADR-0047 §8's dual-kind window keeps BOTH (or no filter at all) until every producer on this machine is verified upgraded, because a one-sided filter silently drops the other kind during the mixed-producer window. Narrowing is legitimate once both the Codex shuttle and the attention sensor are confirmed on the response-needed contract; if that is not yet verified, answer notify_kinds=${UNSET} or name both kinds.`;
}

/**
 * Fold a run's `choices[]` ledger into the STANDING decision per value step.
 *
 * The ledger is append-only and replay is its purpose (§3: "the run is
 * replayable from its own manifest"), so the standing decision is what a replay
 * arrives at: rows in file order, later rows winning.
 *
 * Three rules that are not obvious:
 *
 *   * PER-KEY MERGE, not whole-payload replacement. A later partial payload
 *     updates the keys it NAMES and leaves the others standing. Replacement was
 *     the alternative and it is unsafe in the same way an ignored answer is: a
 *     row naming one key would silently un-decide the other two, and nothing in
 *     the report would show that it had. `decline` remains the only way to
 *     un-decide, and it un-decides the whole step, visibly.
 *   * `decline` TOMBSTONES the accumulated decisions. A refusal is not a partial
 *     value, so a later `set:` starts from empty rather than resurrecting the
 *     keys a decline withdrew.
 *   * `set:` is honoured ONLY on a value step. This is the LEGACY-PROVENANCE
 *     guard: the 1.2 run schema never constrained `answer` vocabulary
 *     (`type:[string,null], maxLength:1024`), so an operator-edited or otherwise
 *     arbitrary `set:...` string can already sit in a valid pre-1.3 manifest.
 *     Value steps did not exist before 1.3, so no legacy row can name one, and
 *     honouring the prefix only there is what stops migration from retroactively
 *     turning meaningless bytes into policy. A malformed payload on a real value
 *     step is REPORTED and ignored, never obeyed and never thrown — stored rows
 *     are not revalidated on write, so a fold that threw would strand the run.
 */
export function foldStandingDecisions(choices) {
  const standing = new Map();
  const malformed = [];
  let ordinal = -1;
  for (const row of Array.isArray(choices) ? choices : []) {
    ordinal += 1;
    const stepId = row?.step_id;
    const answer = row?.answer;
    if (typeof stepId !== 'string' || !isValueStep(stepId)) continue;
    const classified = classifyAnswer(answer);
    if (classified.kind === 'set') {
      const parsed = parseSetPayload(stepId, classified.payload);
      if (!parsed.ok) {
        // Located by ordinal, never quoted — the same non-disclosure discipline
        // the incoming-answers boundary applies to a value that failed its check.
        malformed.push(`choices[${ordinal}] carries a set: answer for ${stepId} that this runtime cannot parse; it is ignored rather than obeyed (${parsed.errors.length} defect${parsed.errors.length === 1 ? '' : 's'})`);
        continue;
      }
      const entry = standing.get(stepId) ?? { mode: 'none', decisions: new Map(), at: null };
      const decisions = entry.mode === 'decline' ? new Map() : new Map(entry.decisions);
      for (const [key, value] of parsed.decisions) decisions.set(key, value);
      standing.set(stepId, { mode: 'set', decisions, at: typeof row.at === 'string' ? row.at : null });
      continue;
    }
    if (answer === 'decline') {
      standing.set(stepId, { mode: 'decline', decisions: new Map(), at: typeof row.at === 'string' ? row.at : null });
    }
    // Every other bare answer is refused against a value step at the answers
    // boundary (`answerRefusal`), so there is no fold rule for it. A row that
    // predates the refusal cannot exist: value steps are 1.3-only.
  }
  return { standing, malformed };
}

/**
 * Is the standing decision COMPLETE — does it carry a decision for every key the
 * step owns? A partial decision is a real, legal state (an interview can be
 * answered over several resumes); it simply does not satisfy the step.
 */
export function undecidedKeys(stepId, entry) {
  const keys = valueStepKeys(stepId) ?? [];
  if (!entry || entry.mode !== 'set') return [...keys];
  return keys.filter((key) => !entry.decisions.has(key));
}

/**
 * Compare a standing decision against what the user-global config reader
 * OBSERVED, key by key.
 *
 * `observedOf(key)` returns the persisted value, or `null` for a key that is not
 * present in the file. The distinction between `null` (absent) and `''`
 * (present and blank) is preserved by `parseRuntimeConfigToml` on purpose and is
 * load-bearing here: `UNSET` is satisfied ONLY by physical absence, because a
 * present blank is a byte the operator has to remove before the key is really
 * open — even though `parseKindsFilter` happens to treat it as no filter today.
 */
export function compareStanding(stepId, entry, observedOf) {
  const keys = valueStepKeys(stepId) ?? [];
  const matched = [];
  const mismatched = [];
  for (const key of keys) {
    if (!entry?.decisions?.has(key)) continue;
    const want = entry.decisions.get(key);
    const got = observedOf(key);
    const ok = want === UNSET ? got === null : got === want;
    (ok ? matched : mismatched).push({ key, want, got });
  }
  return { matched, mismatched };
}

/**
 * The `runtime:settings` command that would make the machine match the standing
 * decision — or `null` when the decision needs no write at all.
 *
 * Two halves, because the config layer has two operations and the interview can
 * ask for both in one answer:
 *
 *   * keys with a VALUE become `--<kebab-key> <value>`;
 *   * keys chosen `UNSET` that are currently PRESENT become `--unset <key>`,
 *     the removal operation. A key chosen unset that is already absent
 *     contributes nothing — passing it would be a write the choice declined.
 *
 * `--target user` and not the `both` default: two of the three session keys are
 * in `USER_SCOPE_ONLY_CONFIG_KEYS`, the Stage-4 judge reads the user layer
 * exclusively, and a machine bootstrap records the OPERATOR's default rather than
 * a checkout's policy (§4.4).
 */
export function applyCommandFor(stepId, entry, observedOf) {
  const keys = valueStepKeys(stepId) ?? [];
  const sets = [];
  const unsets = [];
  for (const key of keys) {
    if (!entry?.decisions?.has(key)) continue;
    const want = entry.decisions.get(key);
    const got = observedOf(key);
    if (want === UNSET) {
      if (got !== null) unsets.push(key);
      continue;
    }
    if (got !== want) sets.push([key, want]);
  }
  if (sets.length === 0 && unsets.length === 0) return null;
  const parts = ['runtime:settings --apply --target user'];
  for (const [key, value] of sets) parts.push(`--${key.replace(/_/g, '-')} ${quoteIfNeeded(value)}`);
  if (unsets.length > 0) parts.push(`--unset ${unsets.join(',')}`);
  return parts.join(' ');
}

function quoteIfNeeded(value) {
  // The comma is in the safe set because a kind LIST is the common value here
  // and the unquoted form is what an operator would type. Every value reaching
  // this point has passed a closed-set validator, so the character domain is
  // fully constrained — the quoting is presentation, never a sanitizer.
  return /^[A-Za-z0-9_.,:-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * The decision menu for one config key — every legal value, what leaving it
 * unset means, and the shipped default that unset resolves to.
 *
 * Built from the key's OWN contract (`SESSION_KEY_DEFAULTS`, `NOTIFY_KEY_DEFAULTS`,
 * the enum constants) rather than hand-written prose, so a key whose domain or
 * default changes changes the menu with it. The one thing that IS prose is what
 * unset MEANS, and it differs per key in a way no constant carries: for a session
 * key unset resolves to a definite shipped default, while for `notify_kinds` it
 * means future-open ALL kinds — including kinds this runtime has not shipped yet.
 */
export function valueKeyMenu(key) {
  if (key === 'notify_kinds') {
    return {
      key,
      values: [...NOTIFY_KINDS],
      form: 'a comma-separated SUBSET of the kinds above',
      unset_resolves_to: 'every kind, including kinds a future runtime adds (parseKindsFilter returns no filter)',
      unset_is_recommended_over: `enumerating all ${NOTIFY_KINDS.length} kinds, which is identical today and permanently narrower tomorrow`,
      shipped_default: NOTIFY_KEY_DEFAULTS[key] ?? null,
    };
  }
  const domains = {
    session_capture: SESSION_CAPTURE_MODES,
    entry_brief: ENTRY_BRIEF_MODES,
    entry_brief_empty: ENTRY_BRIEF_EMPTY_MODES,
  };
  return {
    key,
    values: [...(domains[key] ?? [])],
    form: 'exactly one of the values above',
    unset_resolves_to: SESSION_KEY_DEFAULTS[key] ?? null,
    user_scope_only: USER_SCOPE_ONLY_CONFIG_KEYS.includes(key),
    shipped_default: SESSION_KEY_DEFAULTS[key] ?? null,
  };
}
