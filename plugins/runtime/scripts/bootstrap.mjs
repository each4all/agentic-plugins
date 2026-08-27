#!/usr/bin/env node
// plugins/runtime/scripts/bootstrap.mjs
//
// runtime:bootstrap — the §3 public surface of machine-bootstrap-contract.md:
// the machine-scoped, artifact-only lifecycle that takes a machine from a bare
// host to a proven agentic-plugins install (ADR-0046 §1, the tenth runtime
// command).
//
// THIN orchestration, by design: facts come from lib/machine-probe.mjs, schemas
// from lib/schema-validate.mjs + data/schemas/, storage from
// lib/bootstrap-artifacts.mjs, the expected-step registry from
// lib/step-registry.mjs, and the completion reducer from
// lib/completion-reducer.mjs. This file owns only the §3 grammar, the §5
// serialization glue, the step judgement from observed probe facts, and the
// stage presentation (fragments + apply commands + §10.3 guidance). No schema
// decision lives here or in any markdown — the contract owns those.
//
// Boundaries this file enforces rather than documents:
//   - R0 verbs (`status`, `verify`) write NOTHING — they re-probe, compute
//     invalidation in memory, and report (§3; test #33 digests the whole home).
//   - `resume` is the only M1 verb that produces Stage-8 evidence: it invokes
//     `runtime:doctor --record` with an explicit repo-root and copies proof
//     METADATA ONLY into the run (§8.2, as corrected by the S8b C0 errata).
//   - Bootstrap presents `runtime:settings --execute-plugin-management` with the
//     §1.6 plan hash; it NEVER executes plugin management itself (no second
//     executor, ADR-0046 §5; test #9).
//   - It never writes host config, never writes a credential, never performs a
//     network request (§1; the manifest's boundary object is validated all-false).

import { spawn } from 'node:child_process';
// Static read-only fs imports — the ADR-0035 fs-mutation-gate refuses dynamic
// fs imports outright (they defeat the import-anchored mutation model), and
// these two are plain reads with no registration need.
import { readFile, stat } from 'node:fs/promises';
import { homedir, hostname as osHostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePrereleaseAware } from './lib/runtime-floor.mjs';
import { RUNTIME_VERSION } from './version.mjs';

export { comparePrereleaseAware };
import {
  BOOTSTRAP_RUN_SCHEMA_VERSION,
  BOOTSTRAP_TERMINAL_RUN_STATUSES,
  abandonBootstrapRun,
  bootstrapFragmentsDir,
  createBootstrapRun,
  readBootstrapProofRecords,
  resolveMachineArtifactHome,
  scanBootstrapRuns,
  selectBlockingRuns,
  updateBootstrapRun,
  validateProfileName,
  writeBootstrapFragment,
  writeBootstrapProof,
  writeMachineProfile,
} from './lib/bootstrap-artifacts.mjs';
import { CANONICAL_MARKETPLACE, PLUGIN_NAMES, probeMachineHostState } from './lib/machine-probe.mjs';
import {
  BUNDLE_NAMES,
  MANDATORY_PLUGINS,
  codexHookBearingPlugins,
  hardClosureViolations,
  loadPluginSet,
  resolveBundle,
  validatePluginSet,
} from './lib/plugin-set.mjs';
// §6.2 — the retained set every selection-derived expectation is owed against.
// `selection.desired` is the PLAN; this is what the operator did not refuse.
import { effectiveSelection, hostPluginsOf, narrowSelectionByDeclines, narrowSelectionToEffective } from './lib/effective-selection.mjs';
import { PROOF_KINDS, deriveActivationFingerprint } from './lib/evidence-contract.mjs';
import {
  STATUSLINE_PRESET_AGENTIC_6,
  classifyExistingClaudeStatusline,
  evaluateInlineSufficiency,
  expectedClaudeStatuslineCommand,
  expectedCodexStatusLineItems,
  renderAgenticStatuslineShim,
  renderClaudeStatuslineFragmentJson,
  renderCodexStatusLineFragmentToml,
  statuslineShimInstallPath,
} from './lib/statusline-plan.mjs';
import { inspectInstalledReceivers } from './lib/receiver-inventory.mjs';
import { OPT_IN_PROOF_STEPS, PROOF_STAGES, deriveExpectedSteps, stepIds, validateStepGraph } from './lib/step-registry.mjs';
import {
  SET_ANSWER_PREFIX,
  UNSET,
  applyCommandFor,
  classifyAnswer,
  compareStanding,
  dualKindWarning,
  foldStandingDecisions,
  isValueStep,
  parseSetPayload,
  VALUE_STEPS,
  undecidedKeys,
  validateValueForKey,
  valueKeyMenu,
  valueStepKeys,
} from './lib/answer-values.mjs';
import {
  currentBoundVersions,
  egressProofOptedIn,
  importHookAttestation,
  importProofMetadata,
  invalidateStaleSteps,
  projectLegacyCompletion,
  recomputeHookAttestation,
  reduceCompletion,
} from './lib/completion-reducer.mjs';
import { EGRESS_CREDENTIAL_ENV_VAR, buildMachineProfile, canonicalProfile, profileHash, profileWriteGate, seedProposals } from './lib/machine-profile.mjs';
import {
  projectClaudePermission,
  projectClaudeStatusline,
  readUserGlobalClaudeSettings,
  resolveClaudeConfigDir,
  projectCodexPermission,
  projectModelEffort,
  projectNotify,
  projectSession,
  readUserGlobalEgress,
  readUserGlobalRuntimeConfig,
} from './lib/profile-readers.mjs';
// The named E1 activation checker (ADR-0048 §4): egress.configured is judged
// from ACTIVATION semantics — channel + recipient + credential PRESENCE — not
// the credential-independent §4.4 export shape. Only loadEgressActivation may
// inspect the credential (for presence/collision, in-process); the value never
// reaches this module. EGRESS_ENV_KEYS is imported for the recovery TEXT (the
// key NAME as a placeholder procedure), never for an env read here.
import { EGRESS_ENV_KEYS, loadEgressActivation } from './lib/egress-config.mjs';
// §6.1 Stage 4 — the declarable model/effort postures. Imported (not restated)
// so the judge, the settings validator and the contract cannot drift apart.
import { CONFIG_KEY_VALIDATORS, ENTRY_BRIEF_ENV_KEYS, MODEL_EFFORT_FALLBACK_POSTURES } from './lib/runtime-config.mjs';
import { FINDINGS_MAX_PER_ARTIFACT, loadSchema, makeValidator } from './lib/schema-validate.mjs';
import { TUI_NOTIFICATIONS_VALUES, expectedCodexNotifyArgv, gatherCodexNotificationInputs, buildCodexNotificationPlanSection, makeNotificationRunId, parseCodexNotifyConfigToml } from './lib/notification-plan.mjs';
import { renderCodexTuiTableToml } from './lib/toml.mjs';
import { gatherEgressLauncherInputs, buildEgressLauncherPlanSection, egressFragmentApplyGuidance, makeEgressLauncherRunId } from './lib/egress-launcher-plan.mjs';
import { gatherPermissionPlanInputs, buildPermissionPlanSection } from './lib/permission-plan.mjs';
import { makePermissionRunId } from './lib/permission-artifacts.mjs';

export { RUNTIME_VERSION };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUN_SCHEMA_VERSION = BOOTSTRAP_RUN_SCHEMA_VERSION;

// §3.1 — the exit-code contract. These are the ONLY codes this command exits
// with; a verb maps its completion state through EXIT_BY_STATE below.
// LEGACY_HISTORICAL (ADR-0048 §1): a TERMINAL run recorded under an older
// schema minor is immutable historical evidence — status/verify summarize its
// stored completion under the §3.2 disclosure invariant and re-certify nothing,
// so exit 0 (which implies a CURRENT completion) would overclaim. The distinct
// code says exactly "historical record shown, nothing re-proven".
export const EXIT = Object.freeze({
  COMPLETE: 0,
  OK: 0,
  CONFIGURED_NOT_VERIFIED: 10,
  INCOMPLETE: 20,
  NO_ACTIVE_RUN: 30,
  INVALID: 40,
  LEGACY_HISTORICAL: 50,
  UNEXPECTED: 1,
});

// The run schema family+minor, parsed for the §4.1/§7 migration decisions.
function parseRunSchemaMinor(schema) {
  const m = typeof schema === 'string' ? schema.match(/^runtime-bootstrap-run-(\d+)\.(\d+)$/) : null;
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}
const READER_RUN_SCHEMA = parseRunSchemaMinor(RUN_SCHEMA_VERSION);

const EXIT_BY_STATE = Object.freeze({
  complete: EXIT.COMPLETE,
  'configured-not-verified': EXIT.CONFIGURED_NOT_VERIFIED,
  incomplete: EXIT.INCOMPLETE,
});

// §2 — the exact Stage 0 blocks. README.md and the contract carry the same
// commands; §11.3 pins the agreement, so these strings are the single in-code
// copy both presentation paths render.
export const STAGE0_COMMANDS = Object.freeze({
  claude: Object.freeze([
    'claude plugin marketplace add each4all/agentic-plugins',
    'claude plugin install runtime@agentic-plugins',
  ]),
  codex: Object.freeze([
    'codex plugin marketplace add each4all/agentic-plugins',
    'codex plugin add runtime@agentic-plugins',
  ]),
});

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT.INVALID;
  }
}

// ---------------------------------------------------------------------------
// §3 grammar
// ---------------------------------------------------------------------------

const RUN_SELECTORS = ['--run-id', '--latest', '--latest-open'];

// The run schema's `maxItems` for `choices` and `history`. Duplicated here as a
// PREFLIGHT bound, not as a second source of truth: the schema still refuses an
// over-cap document, and a test pins the two together so this constant cannot
// drift below the thing it is predicting.
const LEDGER_MAX_ITEMS = 256;

// Every config key the value interview owns, flattened — used to decide whether
// a seeded profile value will have to pass the value grammar. Derived from
// VALUE_STEPS so a key added to a family joins this set with it.
const VALUE_KEYS = new Set(Object.values(VALUE_STEPS).flatMap((entry) => entry.keys));

// Per-verb flag whitelists — the grammar block, verbatim. `--answers` is
// accepted on exactly the two interview verbs and NO other (§3; test #34):
// `status`/`verify`/`abandon` conduct no interview, and `profile seed` takes a
// PROFILE (defaults), not ANSWERS (decisions).
const VERB_FLAGS = Object.freeze({
  plan: ['--bundle', '--plugins', '--profile-file', '--answers', '--format'],
  status: ['--run-id', '--latest', '--latest-open', '--format'],
  resume: ['--run-id', '--latest-open', '--answers', '--format'],
  verify: ['--run-id', '--latest', '--format'],
  abandon: ['--run-id', '--latest-open', '--reason'],
  // ADR-0048 §3 / D0.1 — the post-terminal receipt verb: records the owner's
  // phone-receipt testimony against a run whose final proof send already
  // terminalized it (resume refuses terminal runs, so testimony needed a door
  // of its own). Not an interview verb — no --answers; the testimony IS the
  // action.
  attest: ['--run-id', '--latest', '--format'],
  // `--format` reaches these two like every other reporting verb in §3. They
  // were the only ones without it, which made them the only verbs whose output
  // was strictly LESS than what they computed: `profile export` returns the
  // pointer and hash of the file it just wrote, `profile seed` returns every
  // §4.5 proposal and every safety-graded note, and with no JSON door and no
  // text rendering, a caller had no way to read any of it.
  'profile export': ['--name', '--from-run', '--overwrite', '--format'],
  'profile seed': ['--profile-file', '--run-id', '--latest-open', '--format'],
});

const VALUE_FLAGS = new Set(['--bundle', '--plugins', '--profile-file', '--answers', '--format', '--run-id', '--reason', '--name', '--from-run']);
const BOOLEAN_FLAGS = new Set(['--latest', '--latest-open', '--overwrite']);

export function parseBootstrapArgs(argv) {
  const args = [...argv];
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { verb: 'help' };
  }
  let verb = args.shift();
  if (verb === 'profile') {
    const sub = args.shift();
    if (sub !== 'export' && sub !== 'seed') {
      throw new UsageError(`unknown profile subcommand '${sub ?? ''}' (expected: profile export | profile seed)`);
    }
    verb = `profile ${sub}`;
  }
  if (!(verb in VERB_FLAGS)) {
    throw new UsageError(`unknown verb '${verb}' (expected: plan | status | resume | verify | attest | abandon | profile export | profile seed)`);
  }

  const allowed = new Set(VERB_FLAGS[verb]);
  const opts = { verb, format: 'text' };
  while (args.length > 0) {
    const flag = args.shift();
    if (!flag.startsWith('--')) throw new UsageError(`unexpected positional argument '${flag}'`);
    if (!allowed.has(flag)) {
      // Name the §3 rule for the one flag with a rule of its own, so the
      // diagnostic teaches the grammar instead of just refusing it.
      if (flag === '--answers') {
        throw new UsageError(`--answers is accepted on exactly the two interview verbs — plan and resume — and on no other (§3); '${verb}' conducts no interview`);
      }
      if (flag === '--out') {
        throw new UsageError('there is no --out: writes are constrained to the authorized machine-global home (§3, §10)');
      }
      throw new UsageError(`flag ${flag} is not part of the '${verb}' grammar (§3 allows: ${VERB_FLAGS[verb].join(' ') || '<none>'})`);
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = args.shift();
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
      opts[flag.slice(2).replace(/-/g, '_')] = value;
    } else if (BOOLEAN_FLAGS.has(flag)) {
      opts[flag.slice(2).replace(/-/g, '_')] = true;
    }
  }

  const selectors = RUN_SELECTORS.filter((f) => {
    const key = f.slice(2).replace(/-/g, '_');
    return opts[key] !== undefined;
  });
  if (selectors.length > 1) {
    throw new UsageError(`${selectors.join(' and ')} are mutually exclusive (§3 run selection)`);
  }
  if (opts.format !== 'text' && opts.format !== 'json') {
    throw new UsageError(`--format must be text or json (got '${opts.format}')`);
  }
  if (verb === 'plan') {
    if (opts.bundle === 'custom' && !opts.plugins) {
      throw new UsageError('--bundle custom REQUIRES --plugins <csv> (§3)');
    }
    if (opts.plugins && opts.bundle !== 'custom') {
      throw new UsageError('--plugins is only meaningful with --bundle custom (§3)');
    }
  }
  if (verb === 'abandon' && !opts.run_id && !opts.latest_open) {
    throw new UsageError('abandon requires --run-id <id> or --latest-open (§3)');
  }
  if (verb === 'profile seed' && !opts.profile_file) {
    throw new UsageError('profile seed requires --profile-file <path> (§3)');
  }
  return opts;
}

// ---------------------------------------------------------------------------
// The prerelease-aware floor comparator MOVED to `lib/runtime-floor.mjs`
// (ADR-0054 §Decision 5). Three callers need it — this file, the assurance
// ladder and the cutover gate — and two of them are libraries, so keeping it in
// a command module would have made a library import a command.
//
// The move also HARDENED it, and the hardening is why the import is not a
// no-op: the parse here was a prefix regex with no end anchor, so against a
// `0.91.0` floor the strings `0.91.0junk` and `0.91.0.1` compared EQUAL and
// `01.91.0` compared ABOVE. A floor exists to refuse versions; a parse that
// accepts malformed text as satisfying one is the defect it cannot have.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §5 probe serialization — raw machine probe → the run manifest's probe object
// ---------------------------------------------------------------------------

const SEMVER_IN_TEXT_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

function extractCliVersion(cliFacts) {
  if (cliFacts?.status !== 'available') return null;
  const match = String(cliFacts.version?.text ?? '').match(SEMVER_IN_TEXT_RE);
  return match ? match[0] : null;
}

function pluginStatesFor(host, raw) {
  const rows = raw?.installed?.[host] ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const listOk = host === 'claude'
    ? raw?.claude?.plugin?.status === 'available'
    : raw?.codex?.plugin_list?.status === 'available';
  const out = {};
  for (const name of PLUGIN_NAMES) {
    const row = byId.get(name);
    if (row) {
      // Codex reports a per-plugin enabled boolean; enabled === false is the
      // `disabled` state. Claude has no disabled state to report (test #31).
      const state = host === 'codex' && row.enabled === false ? 'disabled' : 'installed';
      out[name] = { version: row.version ?? null, state };
    } else {
      out[name] = { version: null, state: listOk ? 'missing' : 'unknown' };
    }
  }
  return out;
}

// §5 / 1.1 (S8a5) — project the raw `[hooks.state]` read into the probe's
// PER-HANDLER hook-state evidence. The reducer SEMANTICALLY requires it for a
// current applicable attestation, so omitting it would stale every persona
// bundle's Stage 7 forever (Codex Plan-verify blocker). `disabled_expected`
// lists explicitly disabled (`enabled === false`) agentic-plugins handlers;
// the reducer projects that down to the run's own selection.
function hookStateFor(raw) {
  const config = raw?.codexHookConfig;
  const observation = config?.config_status;
  if (!['available', 'missing', 'unreadable'].includes(observation)) return null;
  const disabled = (Array.isArray(config.entries) ? config.entries : [])
    .filter((entry) => entry?.enabled === false && entry.marketplace === 'agentic-plugins' && typeof entry.plugin === 'string')
    .map((entry) => ({
      plugin: entry.plugin,
      hooks_path: typeof entry.hooks_path === 'string' ? entry.hooks_path : null,
      event: typeof entry.event === 'string' ? entry.event : null,
      group_index: entry.group_index == null ? null : String(entry.group_index),
      hook_index: entry.hook_index == null ? null : String(entry.hook_index),
    }));
  return { observation, disabled_expected: disabled };
}

/**
 * Serialize the raw `probeMachineHostState()` result into the §5 `probe` object
 * the schema, the reducer, and the profile builder all consume. Volatile field:
 * `probed_at` only.
 */
export function serializeProbe({ raw, runtimeVersion = RUNTIME_VERSION, now }) {
  const hosts = {};
  for (const host of ['claude', 'codex']) {
    hosts[host] = {
      cli_version: extractCliVersion(raw?.[host]),
      auth: ['available', 'unauthenticated', 'sandbox_limited'].includes(raw?.[host]?.auth?.status)
        ? raw[host].auth.status
        : 'unknown',
      marketplace: ['registered', 'missing'].includes(raw?.marketplaceRegistration?.[host]?.status)
        ? raw.marketplaceRegistration[host].status
        : 'unknown',
      plugins: pluginStatesFor(host, raw),
    };
  }
  const hookState = hookStateFor(raw);
  if (hookState) hosts.codex.hook_state = hookState;
  return {
    probed_at: new Date(now).toISOString(),
    runtime_version: runtimeVersion,
    hosts,
  };
}

// ---------------------------------------------------------------------------
// Step judgement — observed probe facts → §6 step statuses
// ---------------------------------------------------------------------------

function appliedByFor(step) {
  if (step.stage === 3) return 'h2-executor';
  if (step.stage === 4) return 'agentic-config';
  if (step.stage === 8) return null;
  return 'operator';
}

// §10.3 — render-and-confirm guidance carried on every operator-applied
// fragment step: backup before applying, verify by re-probe, revert manually.
function guidance103(target) {
  return `Backup ${target} before applying (copy it aside); after applying, re-run \`runtime:bootstrap resume --latest-open\` so a live re-probe confirms the step; to undo, restore your backup manually — bootstrap never reverses an operator edit (§10.3).`;
}

function raiseStage0(presentation, host, reason) {
  presentation.stage0[host] = { needed: true, reason, commands: [...STAGE0_COMMANDS[host]] };
}

/**
 * Judge every expected step from the CURRENT probe (§6: `satisfied` is reserved
 * for observed state; `unknown` is never satisfied). Prior manifest state
 * contributes exactly two things: recorded declines (kept only where the
 * registry says declinable) and recorded fragment_applied flags.
 */
/**
 * Resolve the match-candidate set for a desired-bound exact probe: a persisted
 * `desired` (JSON string array) NARROWS the candidates to exactly the plan's
 * expectation; an unreadable desired returns null (fail-closed — the caller
 * reports manual-follow-up rather than silently widening the match — peer G7);
 * no desired keeps the broad canonical set.
 */
function boundExpected(previous, broadCandidates) {
  if (typeof previous?.desired !== 'string') return broadCandidates;
  try {
    const bound = JSON.parse(previous.desired);
    if (!Array.isArray(bound) || !bound.every((item) => typeof item === 'string')) return null;
    // The manifest is operator-editable (Review peer MAJOR): a desired that is
    // not one of the CANONICAL candidates would otherwise smuggle an arbitrary
    // expectation in and have the judge report it as canonical. The seat may
    // only NARROW the canonical set, never replace it.
    const canonical = broadCandidates.some((candidate) => Array.isArray(candidate)
      && candidate.length === bound.length && candidate.every((item, i) => item === bound[i]));
    return canonical ? [bound] : null;
  } catch {
    return null;
  }
}

/**
 * ENV shadowing over the persisted user posture, for the keys that have an env
 * override at all (ADR-0045 §7 gives `entry_brief`/`entry_brief_empty` one;
 * nothing else in these families does).
 *
 * Surfaced rather than judged: the step certifies the PERSISTED posture, so an
 * env override never makes it unsatisfied — it makes the satisfied posture not
 * be the effective one, which is a different sentence and the operator is owed
 * both. Repo shadowing has no equivalent here because §1.1 keeps bootstrap off
 * the repo-scoped reader seam; it is a named boundary, not an oversight.
 */
/**
 * §3.2, applied to a CONFIG VALUE: it crosses the artifact → report boundary iff
 * this runtime's own grammar clamps it.
 *
 * Every value key here has a closed-set validator (`validateValueForKey`), so
 * the question is decidable rather than a judgement call: a value that PASSES is
 * one of a fixed set of tokens this runtime declared, and is safe to name; a
 * value that FAILS is unclamped operator-authored text by definition — the exact
 * class §3.2 withholds — and leaves as its type and length only.
 *
 * Two leaks were reproduced before this existed, and both were mine:
 *   * the value-step judge interpolated the raw persisted config value into
 *     `steps[].observed`, which is a maxLength-only field, so a private path or
 *     marker sitting in a config file crossed verbatim into JSON and text;
 *   * `plan --profile-file` put raw `seedProposals` into the report, extending a
 *     leak the code already acknowledged for `profile seed` (the text half was
 *     repaired long ago; `--format json` still serialized `value` raw).
 */
function discloseConfigValue(key, value) {
  if (value === null || value === undefined) return { disclosed: true, text: '<absent>' };
  if (value === '') return { disclosed: true, text: '<blank>' };
  if (typeof value !== 'string') return { disclosed: false, text: `<${typeof value} — withheld per §3.2>` };
  const verdict = validateValueForKey(key, value);
  if (verdict.ok) return { disclosed: true, text: verdict.normalized };
  return { disclosed: false, text: `<string, ${value.length} chars — not a value this runtime declares; withheld per §3.2>` };
}

/**
 * §3.2 applied to the SEED PROPOSAL list, at report-BUILD time.
 *
 * Build time and not render time, which is the whole repair: the text half was
 * fixed long ago with `describeWithheld`, but `--format json` serializes the
 * report object, so `proposals[].value` still crossed raw — a leak the code
 * acknowledged for `profile seed` and that adding proposals to `plan
 * --profile-file` would have extended (cross-host review, MAJOR). Sanitizing the
 * object closes both doors with one rule.
 *
 * The rule is per-FIELD, which the old comment noted was missing: a config key
 * with a closed-set validator is grammar-clamped, so its value is disclosable —
 * the 1.2 session scalars and the notify enums included. Everything else (the
 * permission arrays, a free-string recipient) leaves as type and length.
 */
/**
 * Mark seeded values the value grammar would refuse, and say so.
 *
 * ONE helper because both entry points that present proposals must agree:
 * `plan --profile-file` and `profile seed` run the same `seedProposals`, so a
 * value flagged by one and offered by the other is the same profile giving two
 * different answers depending on which door the operator used.
 */
function markUnanswerableProposals(result) {
  const warnings = [];
  for (const proposal of result?.proposals ?? []) {
    const key = String(proposal.key).split('.').pop();
    if (!VALUE_KEYS.has(key)) continue;
    const verdict = validateValueForKey(key, proposal.value);
    if (!verdict.ok) {
      proposal.refused_by_interview = verdict.reason;
      warnings.push(`the seeded ${proposal.key} value is not answerable through the interview (${verdict.reason}); it is shown as the source machine's posture, not offered as a default.`);
    }
  }
  return warnings;
}

function sanitizeProposals(result) {
  for (const proposal of result?.proposals ?? []) {
    const key = String(proposal.key).split('.').pop();
    if (Object.hasOwn(CONFIG_KEY_VALIDATORS, key)) {
      const verdict = discloseConfigValue(key, proposal.value);
      proposal.value = verdict.text;
      proposal.value_disclosed = verdict.disclosed;
    } else {
      proposal.value = describeWithheld(proposal.value);
      proposal.value_disclosed = false;
    }
  }
  return result;
}

/**
 * ADR-0047 §8, recomputed from a STANDING ledger.
 *
 * A HELPER because it has to run on every verb that folds one, and it did not:
 * it was inlined in `resume` alone while both the comment beside it and the
 * contract said "on every verb". An operator who answered a one-sided filter at
 * `plan` got no warning there, and `status` showed none either — the hazard was
 * invisible on three of the four verbs that render it (code review, MEDIUM).
 */
/**
 * The plan-time warning for an OPT-IN proof nobody opted into.
 *
 * The failure it names is silent and unrecoverable. A run terminalizes as soon
 * as the reducer says `complete` — which asks only about APPLICABLE proofs — and
 * an opt-in proof is `not-applicable` until the operator requests it. So a run
 * that never opted in closes cleanly around the missing evidence, `resume`
 * refuses a terminal run, and the proof can never be attached: the only recovery
 * is a fresh plan and a re-run of every proof from scratch.
 *
 * Warned rather than refused, because not opting in is the COMMON and correct
 * choice — most machines never egress. What the operator is owed is that the
 * door closes, and when.
 *
 * `expected` is the derived registry (never the manifest's own rows), so a step
 * this selection genuinely does not apply cannot be confused with one the
 * operator merely has not asked for.
 */
function optInProofWarnings({ expected }) {
  const out = [];
  const byId = new Map((expected ?? []).map((step) => [step.id, step]));
  for (const id of OPT_IN_PROOF_STEPS) {
    const step = byId.get(id);
    // `applicable` IS the whole gate, and deliberately the only one. Both call
    // sites derive it from a predicate at least as inclusive as
    // `egressProofOptedIn` — plan from this verb's answers, resume from the
    // manifest's rows, choices and recorded proofs — so an opt-in of ANY
    // provenance has already flipped it to true by the time we get here.
    //
    // A second `egressProofOptedIn(...)` check was written here first and
    // removed on measurement: no mutation could kill it, because it is
    // unreachable. A redundant guard that reads as load-bearing is worse than
    // no guard, so the reachable condition is the one that stays.
    if (!step || step.applicable === true) continue;
    out.push(`${id} is NOT opted in, so this run does not owe it — and once every proof it DOES owe passes, the run terminalizes and resume refuses a terminal run, which means this proof can never be attached to it afterwards (recovery is a fresh plan, re-running every proof). Opt in now with an answers file naming ${id}, or accept that this run will close without that evidence.`);
  }
  return out;
}

function dualKindWarningsFor(standing) {
  const out = [];
  for (const [stepId, entry] of standing ?? new Map()) {
    if (stepId !== stepIds.configNotifyKinds() || entry.mode !== 'set') continue;
    const warning = dualKindWarning(entry.decisions.get('notify_kinds'));
    if (warning) out.push(warning);
  }
  return out;
}

function envShadowFor(keys, readers) {
  const shadowed = readers?.sessionEnvShadow ?? null;
  if (!shadowed) return [];
  return keys.filter((key) => shadowed[key] === true);
}

export function judgeSteps({ expected, probe, raw, pluginSet, readers, hookVerdict, previousById = new Map(), standing = new Map(), now }) {
  const observedAt = new Date(now).toISOString();
  const judged = new Map();
  const floors = Object.fromEntries(
    Object.entries(pluginSet.plugins).map(([name, entry]) => [name, entry.minimum_version ?? null]),
  );

  const observeStatus = (step, previous) => {
    if (!step.applicable) return { status: 'not-applicable' };
    const id = step.id;
    const hostOf = (suffix) => id.split('.')[1];
    if (/^host\.[a-z]+\.present$/.test(id)) {
      const host = hostOf();
      const status = raw?.[host]?.status;
      if (status === 'available') return { status: 'satisfied', observed: probe.hosts[host].cli_version ?? 'available' };
      if (status === 'unavailable') return { status: 'pending', recovery: `Install the ${host} CLI, then re-run bootstrap.` };
      return { status: 'unknown' };
    }
    if (/^host\.[a-z]+\.authenticated$/.test(id)) {
      const host = hostOf();
      const auth = probe.hosts[host].auth;
      if (auth === 'available') return { status: 'satisfied', observed: 'authenticated' };
      if (auth === 'unauthenticated') return { status: 'pending', recovery: `Authenticate the ${host} CLI (its login flow), then re-run bootstrap.` };
      return { status: 'unknown', observed: auth };
    }
    if (/^marketplace\.[a-z]+\.registered$/.test(id)) {
      const host = hostOf();
      const fact = raw?.marketplaceRegistration?.[host];
      if (fact?.status === 'registered') {
        // §1.2 — a directory source is accepted but reported explicitly; it is
        // the contributor-checkout shape, not the canonical consumer remote.
        return {
          status: 'satisfied',
          observed: fact.canonical ? `github:${CANONICAL_MARKETPLACE.repo}` : `${fact.source_kind}:non-canonical`,
          ...(fact.canonical ? {} : { recovery: `Registered from a ${fact.source_kind} source, not the canonical github remote (${CANONICAL_MARKETPLACE.repo}); acceptable for a contributor machine, flagged for a consumer install.` }),
        };
      }
      if (fact?.status === 'missing') {
        return { status: 'pending', apply_command: STAGE0_COMMANDS[host][0], recovery: 'Absence of evidence is never evidence of registration (§1.2); register, then re-probe.' };
      }
      return { status: 'unknown', recovery: 'The host could not answer the marketplace read; unknown is never satisfied (§1.2).' };
    }
    let m = id.match(/^plugin\.([a-z-]+)\.([a-z]+)\.installed$/);
    if (m) {
      const [, name, host] = m;
      const entry = probe.hosts[host].plugins[name];
      const floor = floors[name];
      if (entry?.state === 'installed' || entry?.state === 'disabled') {
        if (floor === null) return { status: 'satisfied', observed: entry.version ?? 'installed' };
        if (entry.version === null) {
          // §13 — an unknown installed version with a non-null floor stays
          // unresolved, never "installed".
          return { status: 'unknown', recovery: `${name} is installed but its version could not be read, and a ${floor} floor applies; unresolved until the version is observable.` };
        }
        const cmp = comparePrereleaseAware(entry.version, floor);
        if (cmp === null) return { status: 'unknown', recovery: `${name} version '${entry.version}' did not parse against floor ${floor}.` };
        if (cmp >= 0) return { status: 'satisfied', observed: entry.version };
        return { status: 'pending', observed: entry.version, recovery: `${name}@${entry.version} is below the ${floor} correctness floor (§1.4); update via the presented plugin-management command.` };
      }
      if (entry?.state === 'missing') return { status: 'pending' };
      return { status: 'unknown' };
    }
    m = id.match(/^plugin\.([a-z-]+)\.codex\.enabled$/);
    if (m) {
      const name = m[1];
      const entry = probe.hosts.codex.plugins[name];
      if (entry?.state === 'installed') return { status: 'satisfied', observed: 'enabled' };
      if (entry?.state === 'disabled') {
        // §2 — a manual enabled=true edit is a failed-post-probe FALLBACK, not
        // an unconditional instruction: `codex plugin add` writes it itself.
        return { status: 'pending', observed: 'disabled', recovery: `Re-run \`codex plugin add ${name}@agentic-plugins\`; only if the post-probe still observes it disabled, set enabled = true for it in $CODEX_HOME/config.toml.` };
      }
      if (entry?.state === 'missing') return { status: 'pending' };
      return { status: 'unknown' };
    }
    if (id === stepIds.configModelEffort()) {
      // §6.1 Stage 4 — the step asks whether this machine's model/effort POSTURE
      // is recorded, and there are two ways to record one: an explicit
      // coordinate, or the `host-native` fallback declaration.
      //
      // Key PRESENCE alone was the old test, and it made a machine that
      // deliberately runs host-default model/effort — the recorded ADR-0024
      // resolution position, and this repository's own dogfood machine —
      // unable to ever reach `complete`. That contradicted the machine's own
      // consuming code (`resolveOneSetting` calls no-key `host-native default`,
      // settings renders it `<host-default>`) and the scorecard's R5 quality
      // contract, which accepts "host-native OR runtime:settings configured".
      const reader = readers?.modelEffort ?? null;
      const keys = reader?.keys ?? {};
      // An UNREADABLE config is not an absent one (§6: unknown is never
      // satisfied). The reader has always distinguished them and the judge has
      // always thrown that away — an EACCES config read as "nothing set" is a
      // pending step whose recovery command would fail the same way.
      if (reader && reader.source?.status !== 'readable' && reader.source?.status !== 'missing') {
        return { status: 'unknown', recovery: `The user-global runtime config could not be read (${reader.source?.status ?? 'unreadable'}); model/effort posture is unobservable until it is. Fix the file's permissions, then re-run.` };
      }
      const posture = keys.model_effort_fallback?.value;
      // A coordinate counts only when it carries a VALUE. `parseRuntimeConfigToml`
      // deliberately preserves a known key with an empty value so the per-key
      // validator can fail closed on it, which the old `!= null` test read as
      // configured: `model = ""` satisfied the step while resolving to nothing.
      const coordinates = Object.entries(keys)
        .filter(([key]) => key !== 'model_effort_fallback')
        .filter(([, v]) => typeof v?.value === 'string' && v.value.length > 0);
      if (coordinates.length > 0) {
        return { status: 'satisfied', observed: coordinates.map(([k, v]) => `${k}=${v.value}`).join(' ') };
      }
      if (typeof posture === 'string' && posture.length > 0) {
        // An INVALID posture is not a posture. The value reaches the judge
        // unvalidated (the validators run on the write path), so a typo would
        // otherwise satisfy the step while `runtime:settings --apply` refuses it.
        if (!MODEL_EFFORT_FALLBACK_POSTURES.includes(posture)) {
          return { status: 'pending', observed: `model_effort_fallback=${posture}`, recovery: `model_effort_fallback must be one of ${MODEL_EFFORT_FALLBACK_POSTURES.join(', ')}; the recorded value declares no posture this runtime understands.` };
        }
        return { status: 'satisfied', observed: `model_effort_fallback=${posture} (no explicit coordinate; the host chooses)` };
      }
      return {
        status: 'pending',
        apply_command: 'runtime:settings --apply --target user (model/effort defaults; agentic-plugins-owned config)',
        recovery: 'Either set an explicit model/effort coordinate, or declare the host-native posture with `runtime:settings --apply --target user --model-effort-fallback host-native` — leaving every coordinate unset is a legitimate choice (§6.1 Stage 4), but it has to be a recorded one.',
      };
    }
    if (isValueStep(id)) {
      // §6.1.3 — the VALUE-BEARING Stage-4 steps. One judge, two steps: the only
      // difference is which reader family carries the keys, and hard-coding two
      // near-copies is how they would drift.
      //
      // What this step certifies is the PERSISTED USER-GLOBAL POSTURE, never the
      // effective value on this machine right now, and the distinction is not a
      // technicality. `notify_kinds` and `session_capture` resolve repo → user →
      // default at runtime and the entry-brief pair resolves env → user →
      // default, so a repo or env layer can shadow a satisfied user posture. That
      // is deliberate and is exactly what `projectSession`'s own contract says
      // ("a profile records the PERSISTED user-global posture, never the
      // effective value… this projection is not that loader"): §1.1 keeps
      // bootstrap off the repo-scoped reader seam, and a machine bootstrap
      // records the OPERATOR's default rather than a checkout's policy (§4.4).
      // ENV shadowing IS surfaced below, because env is already in hand; repo
      // shadowing is a named boundary, diagnosed by runtime:doctor.
      const family = id === stepIds.configNotifyKinds() ? readers?.notify : readers?.session;
      // An UNREADABLE config is not an absent one (§6: unknown is never
      // satisfied) — the same rule the posture step above applies to the same
      // file, which is the only file either of them reads.
      if (family && family.source?.status !== 'readable' && family.source?.status !== 'missing') {
        return { status: 'unknown', recovery: `The user-global runtime config could not be read (${family.source?.status ?? 'unreadable'}); this step's posture is unobservable until it is. Fix the file's permissions, then re-run.` };
      }
      const keys = valueStepKeys(id) ?? [];
      // `null` = the key is not present in the file; `''` = present and blank.
      // parseRuntimeConfigToml preserves that difference on purpose and UNSET is
      // satisfied only by physical ABSENCE — a present blank is a byte the
      // operator still has to remove.
      const observedOf = (key) => family?.keys?.[key]?.value ?? null;
      const entry = standing.get(id) ?? null;
      const undecided = undecidedKeys(id, entry);
      const shadow = envShadowFor(keys, readers);
      const shadowNote = shadow.length > 0
        ? ` An environment override is in force for ${shadow.join(', ')} — this step certifies the persisted user-global posture, and the env value wins at runtime (ADR-0045 §7).`
        : '';
      // A DECLINE recorded in the ledger is authoritative for a value step, and
      // must be read here rather than left to the generic status restoration.
      // The restoration keys on `previous.status === 'declined'`, and
      // `applyAnswers` deliberately skips a step that is already SATISFIED — so
      // declining a satisfied value step left no status trace anywhere, and this
      // judge (seeing no `set:` decision) would have reported `pending` with
      // "no decision is recorded" over a decision that plainly was.
      if (entry?.mode === 'decline') {
        return { status: 'declined', observed: 'left unmanaged by operator decision' };
      }
      if (!entry || entry.mode !== 'set') {
        return {
          status: 'pending',
          apply_command: `runtime:bootstrap resume --latest-open --answers <file>  (answer set:${keys.map((k) => `${k}=<value|unset>`).join(';')} for ${id}; agentic-plugins-owned config)`,
          recovery: `No decision is recorded for ${keys.join(', ')}. Answer the step with a \`set:\` value (or \`unset\` per key to keep the shipped default deliberately), or decline it to leave this config unmanaged.${shadowNote}`,
        };
      }
      if (undecided.length > 0) {
        return {
          status: 'pending',
          observed: `decided: ${[...entry.decisions.keys()].sort().join(', ')}`,
          recovery: `Still undecided: ${undecided.join(', ')}. A partial answer is legal — name the remaining key(s) in a later \`set:\` and the decisions merge.${shadowNote}`,
        };
      }
      const { mismatched } = compareStanding(id, entry, observedOf);
      // `want` is always safe: it came through the value grammar. `got` is raw
      // persisted config text and is disclosed only when it too is a token this
      // runtime declares (§3.2 — see discloseConfigValue).
      const summarize = (rows) => rows.map(({ key, want, got }) => `${key}: chose ${want}, observed ${discloseConfigValue(key, got).text}`).join('; ');
      if (mismatched.length === 0) {
        return {
          status: 'satisfied',
          observed: keys.map((key) => `${key}=${entry.decisions.get(key) === UNSET ? '<unset, observed absent>' : entry.decisions.get(key)}`).join(' '),
          ...(shadow.length > 0 ? { recovery: shadowNote.trim() } : {}),
        };
      }
      const applyCommand = applyCommandFor(id, entry, observedOf);
      // pending vs manual-follow-up is the contract's own distinction: pending
      // means not done, manual-follow-up means a HAND-OFF was rendered and is
      // awaiting action. A previously rendered fragment is that hand-off, so the
      // first pass (nothing rendered yet) is pending and every later one is
      // manual-follow-up.
      return {
        status: previous?.fragment_pointer ? 'manual-follow-up' : 'pending',
        observed: summarize(mismatched),
        ...(applyCommand ? { apply_command: applyCommand } : {}),
        recovery: `The recorded decision has not been observed on this machine yet. ${applyCommand ? `Run the apply command, then resume so a live re-probe confirms it.` : `Nothing needs writing for this decision — resume to re-observe.`}${shadowNote}`,
      };
    }
    if (id === stepIds.notifyConfigured()) {
      const channel = readers?.notify?.keys?.notify_channel?.value ?? null;
      return channel != null
        ? { status: 'satisfied', observed: `notify_channel=${channel}` }
        : { status: 'pending' };
    }
    if (id === stepIds.notifyCodexConfigured()) {
      // ADR-0048 §1 (notify split) — the CODEX-side wiring, judged as an EXACT
      // probe (notify-axis slice): satisfied means the merged `notify =` argv
      // EQUALS the canonical argv this machine's rendered fragment carries
      // (shuttle, or the chain script in wrapper-chain mode) — the same
      // "canonical configuration observed" semantics ADR-0048 §1 pins for the
      // statusline steps. A present, parseable, non-empty argv that is NOT the
      // canonical wiring is `manual-follow-up`: some other notifier is wired,
      // and §2's no-auto-chaining rule makes reconciling it an operator
      // decision, not a silent pass or a silent pending. `notify = []` runs
      // nothing and an unparseable value is a config the host will not run —
      // both stay pending, named. An unreadable config is `unknown` (§6:
      // unknown is never satisfied).
      const wiring = readers?.codexNotify ?? null;
      if (!wiring || wiring.readable === false) return { status: 'unknown', observed: 'the Codex config could not be read' };
      if (!wiring.present) return { status: 'pending' };
      if (!Array.isArray(wiring.argv) || wiring.argv.length === 0) {
        return { status: 'pending', observed: wiring.argv ? 'notify = [] runs nothing' : 'notify is present but not a parseable argv array' };
      }
      // MODE BINDING (Refine-verify peer): once this run rendered a fragment,
      // the step's `desired` carries exactly the argv that fragment asks the
      // operator to merge — and ONLY that argv satisfies (the wrapper-chain
      // plan wrongly merged as the direct shuttle was the reproduced defect).
      // Before any fragment exists, either canonical form is acceptable. An
      // UNREADABLE desired fails closed to manual-follow-up (statusline peer
      // G7 — the broad-set fallback silently widened the match).
      const candidates = boundExpected(previous, wiring.expected ?? []);
      if (candidates === null) {
        return { status: 'manual-follow-up', observed: 'the recorded plan expectation is unreadable', recovery: 'The persisted desired expectation for this step could not be trusted — decline the step, or abandon and re-plan (a version drift also clears it via §7 invalidation).' };
      }
      const matches = candidates.some((expected) => Array.isArray(expected)
        && expected.length === wiring.argv.length
        && expected.every((item, i) => item === wiring.argv[i]));
      if (!matches) {
        return {
          status: 'manual-follow-up',
          observed: `notify argv[${wiring.argv.length}] does not match the canonical receiver wiring`,
          recovery: 'A different notifier is wired in $CODEX_HOME/config.toml. Runtime never auto-chains an existing notifier (ADR-0048 §2 precedent): re-render the notification plan (its read-check offers wrapper-chaining that PRESERVES the existing notifier), review the chain script, and merge that fragment — or decline this step if the current wiring is intentional.',
        };
      }
      // ADR-0040 §4b — SECOND exact predicate. The argv half is canonical, so
      // agent-turn-complete reaches the receiver; approval-requested rides only
      // `[tui] notifications`, and until this check existed a machine with
      // `notifications = false` certified attention that was switched off.
      //
      // Precedence: this predicate is asked ONLY here, once the argv half has
      // already yielded `satisfied`. It may hold that or lower it — it never
      // raises, and it never reclassifies the argv half's own outcomes, so an
      // explicit `notify = []` or an unparseable argv stays `pending` exactly as
      // §6.1's notify rule states.
      //
      // Only `form` is interpreted. `raw` is unusable here: the scanner reports
      // a structurally clean capture for `["a" "b"]` and `true junk` alike, and
      // a redefined [tui] table can carry a canonical-LOOKING raw.
      const notifArgv = `notify argv matches the canonical receiver wiring (argv[${wiring.argv.length}])`;
      const tui = wiring.tuiNotifications ?? { form: 'absent', values: null };
      // Where the operator actually finds the key: a run PRESENTS one [tui]
      // table, and which artifact carries it is decided AFTER this judge runs
      // (the combined statusline-codex fragment when it is the presented
      // source, the notification plan's preview otherwise). The recovery names
      // the table rather than a fragment, because the step's own apply_command
      // points at the notify artifact — which is stripped of this key exactly
      // when the combined fragment holds it.
      const tuiRecovery = 'Merge the canonical `[tui] notifications` key from this run\'s [tui] fragment — the combined statusline-codex fragment when it is the presented source, the notification plan\'s preview otherwise (each artifact names which) — or decline this step if the current selection is intentional.';
      if (tui.form === 'array') {
        const canonical = [...TUI_NOTIFICATIONS_VALUES];
        const tuiMatches = tui.values !== null
          && tui.values.length === canonical.length
          && canonical.every((item, i) => item === tui.values[i]);
        if (tuiMatches) {
          return { status: 'satisfied', observed: `${notifArgv}; canonical [tui] notifications observed` };
        }
        const carriesApproval = Array.isArray(tui.values) && tui.values.includes('approval-requested');
        return {
          status: 'manual-follow-up',
          observed: `${notifArgv}, but [tui] notifications[${tui.values?.length ?? 0}] is a non-canonical selection (${carriesApproval ? 'it does carry approval-requested' : 'it does NOT carry approval-requested'})`,
          recovery: tuiRecovery,
        };
      }
      if (tui.form === 'false') {
        return {
          status: 'manual-follow-up',
          observed: `${notifArgv}, but [tui] notifications = false — approval-requested attention is explicitly disabled`,
          recovery: tuiRecovery,
        };
      }
      if (tui.form === 'true') {
        return {
          status: 'manual-follow-up',
          observed: `${notifArgv}, but [tui] notifications = true is broader than the canonical two-event selection`,
          recovery: tuiRecovery,
        };
      }
      if (tui.form === 'invalid') {
        return {
          status: 'pending',
          observed: `${notifArgv}, but the [tui] notifications value cannot be trusted (duplicate key, redefined [tui] table, or a value this scanner cannot classify)`,
          recovery: 'Normalize `[tui] notifications` to a single, well-formed assignment under exactly one [tui] table, then resume.',
        };
      }
      // form === 'absent'
      return {
        status: 'pending',
        observed: `${notifArgv}, but [tui] notifications is not configured`,
        recovery: tuiRecovery,
      };
    }
    if (id === stepIds.statuslineConfigured('codex')) {
      // ADR-0048 §1 — EXACT probe over the closed [tui].status_line item
      // vocabulary: satisfied means the configured array EQUALS the canonical
      // agentic-6 order element-wise. An ABSENT key means Codex renders its
      // two-item default — that is pending (canonical set not configured),
      // named as such. A present non-canonical non-empty list is the
      // operator's own selection: manual-follow-up, never overwritten.
      const sl = readers?.statuslineCodex ?? null;
      if (!sl || sl.readable === false) return { status: 'unknown', observed: 'the Codex config could not be read' };
      if (!sl.present) return { status: 'pending', observed: 'no status_line configured — Codex renders its default two items' };
      if (!Array.isArray(sl.items)) {
        return { status: 'pending', observed: 'status_line is present but not a parseable item array' };
      }
      if (sl.items.length === 0) {
        // An EMPTY list is a present operator selection (a deliberately
        // disabled statusline), not unfinished configuration (contract
        // §6.1.1: every present non-canonical list is the operator's).
        return { status: 'manual-follow-up', observed: 'status_line = [] — the statusline is deliberately emptied', recovery: 'An empty status_line is a deliberate selection. Merge the rendered [tui] fragment to adopt the canonical agentic-6 set, or decline this step to keep the statusline disabled.' };
      }
      const slCandidates = boundExpected(previous, [sl.expectedItems]);
      if (slCandidates === null) {
        return { status: 'manual-follow-up', observed: 'the recorded plan expectation is unreadable', recovery: 'The persisted desired expectation for this step could not be trusted — decline the step, or abandon and re-plan (a version drift also clears it via §7 invalidation).' };
      }
      const slMatches = slCandidates.some((candidate) => Array.isArray(candidate) && candidate.length === sl.items.length && candidate.every((item, idx) => item === sl.items[idx]));
      if (!slMatches) {
        return {
          status: 'manual-follow-up',
          observed: `status_line[${sl.items.length}] does not match the canonical agentic-6 order`,
          recovery: 'A different status_line item selection is configured in $CODEX_HOME/config.toml. Merge the rendered [tui] fragment to adopt the canonical agentic-6 set, or decline this step if the current selection is intentional.',
        };
      }
      return { status: 'satisfied', observed: 'canonical agentic-6 status_line observed' };
    }
    if (id === stepIds.statuslineConfigured('claude')) {
      // ADR-0048 §1 — "canonical configuration OBSERVED", never "runs":
      // workspace trust, disableAllHooks, and CLAUDE_CODE_SAFE_MODE still gate
      // execution (host-truth §3), and this probe must not overclaim past the
      // settings byte it can actually see. The shim install is deliberately
      // NOT hash-probed here (settings-level semantics; the canonical hash is
      // surfaced in the fragment for the operator's own verify).
      const sl = readers?.statuslineClaude ?? null;
      if (!sl || sl.readable === false) return { status: 'unknown', observed: 'the Claude settings could not be read' };
      const cmdCandidates = boundExpected(previous, [[sl.expectedCommand]]);
      if (cmdCandidates === null) {
        return { status: 'manual-follow-up', observed: 'the recorded plan expectation is unreadable or non-canonical', recovery: 'The persisted desired expectation for this step could not be trusted — decline the step, or abandon and re-plan (a version drift also clears it via §7 invalidation).' };
      }
      const classified = classifyExistingClaudeStatusline({ existing: sl, expectedCommand: cmdCandidates[0][0] });
      if (classified.observation === 'canonical') {
        return { status: 'satisfied', observed: 'canonical statusLine command observed (execution still gated by workspace trust / disableAllHooks / safe mode)' };
      }
      if (classified.observation === 'absent') return { status: 'pending' };
      return {
        status: 'manual-follow-up',
        observed: `existing statusLine is ${classified.observation}`,
        recovery: `${classified.note} Runtime never auto-chains a statusline (ADR-0048 §2).`,
      };
    }
    if (id === stepIds.egressConfigured()) {
      // ADR-0048 §4 / ADR-0041 §2c — "configured" means ACTIVATABLE: channel +
      // recipient + credential presence must all resolve via the named E1
      // checker (token-alone and channel-alone are both inert). Judging this
      // step from the credential-independent export reader's channel was the
      // channel-only false-pass: a channel with no recipient/credential
      // egresses nothing yet reported satisfied.
      const act = readers?.egressActivation ?? null;
      if (act?.active === true) {
        // Presence-only observation: the recipient value and the credential
        // stay out of run artifacts (§5 sanitize discipline; the surfaced
        // channel is enum-safe by the loader's contract).
        return { status: 'satisfied', observed: `channel=${act.channel} recipient=set credential=present` };
      }
      const reason = act?.reason ?? 'missing-activation';
      // On a machine where POSIX uid ownership cannot be proven (e.g.
      // Windows), the verified-local file is never honored — the fail-closed
      // reader ignores it by design (egress-portability decision: env-only
      // over an ACL probe there; the gate itself is unchanged).
      const envOnlyHint = act && act.localLayerSupported === false
        ? ' Note: the verified-local file (~/.agentic-plugins/config.local.toml) is never honored on this machine (POSIX uid ownership unverifiable — e.g. Windows); use the env-only layout.'
        : '';
      return {
        status: 'pending',
        observed: `inactive (${reason})`,
        // The runbook pointer must stay valid on EVERY lifecycle path: resume
        // renders no fragments, so name the always-available settings planner
        // first and this run's fragment only as the when-present alternative
        // (Codex review).
        recovery: `Egress activates only when channel + recipient + credential are all present (ADR-0041 §2c; a channel or token alone is inert). Follow the per-machine egress runbook — \`runtime:settings --egress-launcher-plan\` renders it any time (this run's egress fragment, when present, carries the same runbook) — and export ${EGRESS_ENV_KEYS.credential} yourself in your local shell: bootstrap renders placeholder commands only and never asks for or handles the value (ADR-0048 §4).${envOnlyHint}`,
      };
    }
    m = id.match(/^permission\.([a-z]+)\.applied$/);
    if (m) {
      const host = m[1];
      if (host === 'claude') {
        const perm = readers?.claudePermission ?? {};
        const present = perm.default_mode != null || (perm.allow ?? []).length > 0 || (perm.ask ?? []).length > 0 || (perm.deny ?? []).length > 0;
        return present
          ? { status: 'satisfied', observed: perm.default_mode ? `defaultMode=${perm.default_mode}` : 'permission rules present' }
          : { status: 'pending' };
      }
      const perm = readers?.codexPermission ?? {};
      const present = perm.approval_policy != null || perm.sandbox_mode != null;
      return present
        ? { status: 'satisfied', observed: [perm.approval_policy && `approval_policy=${perm.approval_policy}`, perm.sandbox_mode && `sandbox_mode=${perm.sandbox_mode}`].filter(Boolean).join(' ') }
        : { status: 'pending' };
    }
    if (id === stepIds.hooksAttested()) {
      // §6 — the attestation record is the evidence; a satisfied claim with a
      // stale or absent attestation is a step promoted by assertion.
      return hookVerdict?.status === 'attested'
        ? { status: 'satisfied', observed: 'attested (current bound versions)' }
        : { status: 'pending', recovery: 'Review + trust the packaged Codex hooks in the interactive /hooks TUI, record the attestation via runtime:settings --attest-codex-hook-review, then resume (§8.2 carries it into the run).' };
    }
    if (id.startsWith('proof.')) {
      // Proof STEP status carries only pending/declined; the evidence verdict
      // lives in completion.proofs, recomputed by the reducer.
      return { status: 'pending' };
    }
    return { status: 'unknown' };
  };

  const steps = expected.map((step) => {
    const observed = observeStatus(step, previousById.get(step.id));
    const previous = previousById.get(step.id);
    let status = observed.status;
    // A recorded decline survives a re-probe ONLY where the registry says the
    // step is declinable and observation did not already satisfy it (§6.2).
    if (previous?.status === 'declined' && step.declinable && status !== 'satisfied') status = 'declined';
    const entry = {
      id: step.id,
      stage: step.stage,
      status,
      declinable: step.declinable,
      blocked_by: [...step.blocked_by],
      applied_by: appliedByFor(step),
      observed: observed.observed ?? null,
      observed_at: observedAt,
      // A DECLINED step carries no presentation state (Refine-verify rounds
      // 5-6): its historical fragment/apply/desired are withdrawn at decline
      // time, and a legacy run that recorded them pre-withdrawal drops them
      // here on re-judgement — keyed on the resulting status AND the
      // recorded provenance, because an observation may legitimately flip a
      // legacy declined step to satisfied (§6.2) while its refused render
      // state must still never resurrect.
      fragment_pointer: (status === 'declined' || previous?.status === 'declined') ? null : (previous?.fragment_pointer ?? null),
      apply_command: (status === 'declined' || previous?.status === 'declined') ? null : (observed.apply_command ?? previous?.apply_command ?? null),
      desired: (status === 'declined' || previous?.status === 'declined') ? null : (previous?.desired ?? null),
      fragment_applied: previous?.fragment_applied === true,
      recovery: observed.recovery ?? null,
    };
    // §5 — fragment_applied marks that THIS run rendered a fragment and a later
    // post-probe observed the operator applying it (never a pre-existing match).
    // A DECLINED provenance never reaches this promotion: the pre-judgement
    // strip removed its pointer (and fragment_applied) before `previous` got
    // here, so a satisfying observation over a decline reads as the
    // pre-existing/manual match it is (Refine-verify round 6; pinned by the
    // legacy-resurrection tests — an extra status condition here would be a
    // structurally unreachable branch).
    if (previous && previous.fragment_pointer && previous.status !== 'satisfied' && status === 'satisfied') {
      entry.fragment_applied = true;
    }
    if (previous?.invalidated) entry.invalidated = previous.invalidated;
    judged.set(step.id, entry);
    return entry;
  });

  // Demote unreachable steps to `blocked` AFTER first-pass judgement so the
  // predecessor's own judged status is what gates (§6: blocked = a predecessor
  // prevents it). An observed-satisfied step is never demoted — if it is
  // already true on the machine, no missing predecessor makes it less true.
  const RESOLVED = new Set(['satisfied', 'declined', 'not-applicable']);
  for (const entry of steps) {
    if (entry.status !== 'pending') continue;
    const gate = entry.blocked_by.find((dep) => {
      const parent = judged.get(dep);
      return parent && !RESOLVED.has(parent.status);
    });
    if (gate) {
      entry.status = 'blocked';
      entry.recovery = entry.recovery ?? `Blocked by ${gate}; resolve the predecessor first.`;
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// §3 answers file — the ONLY route interview answers take to the script
// ---------------------------------------------------------------------------

// Bounded untrusted-file read (Codex Plan-verify finding): stat before read so
// an oversized file or a FIFO never defeats the post-parse caps. Regular files
// only; 128 KiB is double the 64 KiB profile cap, comfortably above any honest
// answers file.
const UNTRUSTED_FILE_MAX_BYTES = 128 * 1024;

async function readBoundedFile(path, flag) {
  const resolved = resolve(path);
  let info;
  try {
    info = await stat(resolved);
  } catch (err) {
    throw new UsageError(`${flag} file is unreadable: ${err?.code ?? err?.message ?? String(err)}`);
  }
  if (!info.isFile()) throw new UsageError(`${flag} must name a regular file`);
  if (info.size > UNTRUSTED_FILE_MAX_BYTES) {
    throw new UsageError(`${flag} file is ${info.size} bytes — over the ${UNTRUSTED_FILE_MAX_BYTES}-byte untrusted-input bound; refusing to read it`);
  }
  try {
    return await readFile(resolved, 'utf8');
  } catch (err) {
    throw new UsageError(`${flag} file is unreadable: ${err?.code ?? err?.message ?? String(err)}`);
  }
}

async function readAnswersFile(path) {
  const text = await readBoundedFile(path, '--answers');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // D1 §3.2 — `err.message` from JSON.parse QUOTES THE INPUT
    // (`Unexpected token 'B', "Bearer sk-"... is not valid JSON`), so the
    // answers file would echo its own first bytes into the usage error. The
    // position is runtime-derived and locates the fault without reprinting it.
    throw new UsageError(`--answers file is not valid JSON${jsonParsePosition(err)}; the parser's message is withheld because it quotes the file's own bytes (§3.2)`);
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.answers) ? parsed.answers : null;
  if (!list) throw new UsageError('--answers must be a JSON array of { step_id, answer } (the run\'s choices[] in serialized form, §3)');
  for (const item of list) {
    if (!item || typeof item.step_id !== 'string' || typeof item.answer !== 'string') {
      throw new UsageError('--answers entries must each carry string step_id and answer (§3)');
    }
  }
  return list;
}

export const ANSWER_VALUES = Object.freeze(['decline', 'accept', 'execute', 'attest-receipt']);

const PROOF_STEP_PREFIX = 'proof.';

/**
 * The Stage-8 proof kind a step id names, or null for every other step. The
 * resume executor used to spell this inline as a `startsWith` FILTER, which is
 * why "execute is for proofs" silently dropped the answers it did not match
 * instead of refusing them.
 */
export function proofKindOf(stepId) {
  return stepId.startsWith(PROOF_STEP_PREFIX) ? stepId.slice(PROOF_STEP_PREFIX.length) : null;
}

/**
 * THE answer grammar (§3) — ONE predicate, asked at every boundary that acts on
 * an answer. Returns a refusal string, or null when the answer is legal.
 *
 * It replaces three partial predicates that disagreed: `applyAnswers` validated
 * declinability and nothing else; the resume executor re-implemented "execute is
 * for proofs" as a filter that dropped the rest without a word; and NEITHER
 * asked whether this run's selection applies the step at all. So an answer
 * against a `not-applicable` row was accepted, recorded in `choices[]`, and then
 * invisible — the §11.2 presentation filter (`required || declined`) does not
 * show such a row, correctly, because there is nothing meaningful to show.
 *
 * Applicability is read from the JUDGED status, which is where `applicable:
 * false` lands (§6). That is safe for the one step whose applicability an
 * incoming answer PROMOTES: `proof.egress-provider-ack` derives applicable
 * whenever the answers name it (§8.1), and that derivation runs before
 * judgement, so the grammar never meets it as `not-applicable`. The ordering is
 * load-bearing — a blanket refusal evaluated before the promotion would break
 * the opt-in path outright — and is pinned by test.
 */
export function answerRefusal({ step, answer, verb, applicable }) {
  // Applicability comes from the EXPECTATION, never from the judged status.
  // `judgeSteps` writes `not-applicable` and then RESTORES a prior `declined`
  // over it for any declinable step, so a proof declined in an earlier verb and
  // since made non-applicable reads `declined` — which let both this refusal and
  // the executor's skip miss it entirely, and doctor ran for a step the reducer
  // simultaneously reported `required:false, status:not-applicable`
  // (cross-host Refine-verify, High; reproduced before the fix). The registry's
  // `applicable` flag is the only reading of this question that a status
  // restoration cannot overwrite. It is passed in rather than persisted onto the
  // step, because §4.1/`$defs.step` refuses an unknown key at every minor.
  //
  // ONLY for the answers that would leave no trace. A
  // `decline` against a step this selection does not apply is DELIBERATE and
  // visible: the reducer reports it `required: false, declined: true` and the
  // §11.2 filter (`required || declined`) renders it `not-applicable
  // (declined)` precisely so the refusal cannot vanish, and a declined row is
  // one of the three provenances that opt the egress proof in (§8.1). The
  // defect is the answers that leave `declined: false` — `accept` and
  // `execute` — which no filter shows and no verb acts on. Refusing the whole
  // status would delete a contract-visible path to close an invisible one.
  // §3.3 — the VALUE form and the value STEPS, refused symmetrically. Both
  // directions leave no trace if allowed, which is the same defect the
  // applicability rule below closes:
  //
  //   * `set:` against a step that owns no keys would be recorded in `choices[]`
  //     and read by nothing — the fold honours it only on a value step (which is
  //     also the legacy-provenance guard: a pre-1.3 manifest can carry arbitrary
  //     `set:...` text because the 1.2 schema never constrained the vocabulary).
  //   * `accept` against a value step is the one that would look like it worked.
  //     `accept` means "go ahead, without changing step state", and a value step
  //     has nothing to go ahead with — the value IS the decision. Recording it
  //     would leave the step undecided while the ledger says the operator
  //     answered. `execute`/`attest-receipt` are already refused above by their
  //     own proof-only rules, so this is the whole of the remaining surface.
  const classified = classifyAnswer(answer);
  if (classified.kind === 'set') {
    if (!isValueStep(step.id)) {
      return `answer '${SET_ANSWER_PREFIX}…' targets the value-bearing config steps only (§3.3) — ${step.id} owns no config keys, so the value would be recorded and never read`;
    }
    const parsed = parseSetPayload(step.id, classified.payload);
    if (!parsed.ok) return parsed.errors.join('; ');
  } else if (isValueStep(step.id) && answer === 'accept') {
    const keys = valueStepKeys(step.id) ?? [];
    return `step ${step.id} carries a VALUE, so 'accept' is not the vocabulary for it (§3.3) — it would record a go-ahead while leaving ${keys.join(', ')} undecided. Answer '${SET_ANSWER_PREFIX}${keys.map((k) => `${k}=<value|${UNSET}>`).join(';')}', or decline the step to leave this config unmanaged`;
  }
  if (applicable === false && (answer === 'accept' || answer === 'execute')) {
    return `step ${step.id} is not applicable to this run's selection (§6.1) — refusing to record '${answer}' against it, because no verb would act on it and no report would show it (decline it instead if you mean to record a refusal)`;
  }
  if (answer === 'decline' && !step.declinable) {
    return `step ${step.id} is not declinable (§6.2 — host presence/auth, marketplace registration, runtime, companions, and hard-edge targets are never declinable)`;
  }
  if (answer === 'execute') {
    if (proofKindOf(step.id) === null) {
      return `answer 'execute' targets proof.* steps only (§3) — ${step.id} has no executor behind it, so the approval would be stored and never acted on`;
    }
    // A plan-time `execute` is NOT deferred: `resume` builds its execute set
    // from its OWN answers file, so a plan-time approval is recorded and then
    // never consumed — measured, against an earlier draft of this very comment
    // that claimed the opposite (cross-host Refine-verify, High). One step is
    // genuinely different: any answer naming `proof.egress-provider-ack`
    // promotes it to applicable and lands in `choices[]`, which IS the §8.1
    // opt-in provenance the reducer reads, so a plan-time answer there does
    // real work and the documented plan → resume egress path depends on it.
    if (verb === 'plan' && step.id !== stepIds.proofEgressProviderAck()) {
      return `answer 'execute' is not acted on under plan (§3) — only resume runs a proof executor and it reads its own answers file, so this approval would be stored and never consumed; give it on the resume that should run the proof (proof.egress-provider-ack is the one exception: a plan-time answer there records the §8.1 opt-in)`;
    }
  }
  if (answer === 'attest-receipt') {
    if (step.id !== stepIds.proofEgressProviderAck()) {
      return `answer 'attest-receipt' targets ${stepIds.proofEgressProviderAck()} only — receipt testimony about any other step is not a thing this contract records`;
    }
    if (verb === 'plan') {
      return `answer 'attest-receipt' is not accepted under plan — no provider ack can exist yet, so there is nothing to testify about; use resume or attest`;
    }
  }
  return null;
}

/**
 * Do two standing decisions carry the same per-key answers? Compared as a
 * canonical sorted pair list rather than by identity, so a re-answer that
 * reorders the payload or repeats a value is correctly recognized as changing
 * nothing (the kind list is already normalized to a sorted set by
 * `validateValueForKey`, so this comparison is total).
 *
 * A mode change (`decline` <-> `set`) counts as a change even when the decision
 * map happens to match, because the render state a decline withdrew has to come
 * back.
 */
function sameDecisions(a, b) {
  if ((a?.mode ?? 'none') !== (b?.mode ?? 'none')) return false;
  const flatten = (entry) => [...(entry?.decisions ?? new Map())].sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${k}=${v}`).join(';');
  return flatten(a) === flatten(b);
}

/**
 * Apply an answers list to judged steps. An answer whose step_id is not an
 * expected step of the run is REJECTED (exit 40) rather than recorded — a stale
 * answers file cannot smuggle a step into a manifest the registry never derived
 * (§3, §6.1; test #34). An illegal decline (non-declinable step) is rejected on
 * the same grounds (test #12).
 *
 * Returns `effective` alongside choices/history (ADR-0048 §3): the per-step
 * FINAL answer after file-order last-wins. The pre-1.2 execute pipeline read
 * every raw `execute` row, so `execute` followed by `decline` still executed
 * the proof the operator had just declined — consumers must read `effective`,
 * never re-filter the raw answers.
 *
 * `attest-receipt` (ADR-0048 §3) records the OWNER's phone-receipt testimony
 * intent. Grammar-level rules here: it targets only the egress ack step, and
 * only on an interview verb that can act on it (resume/attest — `plan` renders
 * fragments before any proof can exist, so testimony there is unanchored).
 * The evidence-side preconditions (a current passed ack, not same-run-executed)
 * belong to the attestation pipeline, not the answers grammar.
 */
export function applyAnswers({ steps, answers, now, selection = null, pluginSet = null, verb = 'resume', expected = null, priorChoices = [] }) {
  const at = new Date(now).toISOString();
  const byId = new Map(steps.map((s) => [s.id, s]));
  // The expectation this verb derived, keyed for the applicability question.
  // Absent (a caller that has none) leaves applicability UNJUDGED rather than
  // assumed: refusing on a default would invent a rule from missing data.
  const applicableById = new Map((expected ?? []).map((s) => [s.id, s.applicable !== false]));
  const choices = [];
  const history = [];
  const effective = new Map();
  // TWO PASSES (Codex review MAJOR — a one-pass shape let an EARLIER decline
  // mutate step state permanently even when a LATER answer superseded it:
  // `[decline, execute]` executed the proof while the reducer still saw the
  // step declined and could close configured-not-verified over it).
  //
  // Pass 1 validates every row and records every choice (the audit log keeps
  // ALL of them — the run is replayable from its own manifest), collapsing to
  // one EFFECTIVE action per step, last-wins in file order. Pass 2 applies
  // state transitions from the effective map ONLY.
  // D1 §3.2 — the answers file is operator-authored untrusted input, so a value
  // that FAILED its check is unclamped by definition and is located by its
  // position in the array rather than quoted back. A step id that MATCHED is a
  // registry id this runtime declared, so it keeps being named: withholding it
  // would cost the operator the one thing that makes the error actionable while
  // buying no secrecy at all.
  let answerOrdinal = -1;
  for (const { step_id: stepId, answer } of answers) {
    answerOrdinal += 1;
    const step = byId.get(stepId);
    if (!step) {
      throw new UsageError(`answers[${answerOrdinal}] names a step this run does not expect (§6.1); refusing to record it. The id is withheld because an unmatched step id is free text — expected ids: ${[...byId.keys()].sort().join(', ')}`);
    }
    // §3.3 — the vocabulary is now the four BARE answers PLUS the value form.
    // `ANSWER_VALUES` deliberately keeps naming exactly the bare four: the value
    // form is a prefix family, which a list membership cannot express, so the
    // shape question is asked by a predicate and the payload's legality is asked
    // by `answerRefusal` below (one grammar, one enforcement point).
    if (classifyAnswer(answer).kind !== 'set' && !ANSWER_VALUES.includes(answer)) {
      throw new UsageError(`answers[${answerOrdinal}] carries an answer for ${stepId} that is not one of ${ANSWER_VALUES.join('|')} nor a '${SET_ANSWER_PREFIX}<key>=<value>' value answer; the value is withheld because it did not match the closed set`);
    }
    const refusal = answerRefusal({ step, answer, verb, applicable: applicableById.get(stepId) });
    if (refusal) throw new UsageError(refusal);
    choices.push({ step_id: stepId, answer, at });
    effective.set(stepId, answer);
  }

  for (const [stepId, answer] of effective) {
    if (answer !== 'decline') continue;
    const step = byId.get(stepId);
    if (step.status !== 'satisfied') {
      history.push({ step_id: stepId, from: step.status, to: 'declined', reason: 'operator declined via answers file', at });
      step.status = 'declined';
      // A DECLINED step's rendered hand-off is HISTORY, not presentation
      // (Refine-verify round 5): the operator refused the key, so the frozen
      // fragment / apply command / plan expectation must stop being offered
      // — the same field clearing §7 performs on version drift, here on the
      // operator's own decision (their decline is not the mid-apply state
      // the G7 freeze protects). The physical file stays (freeze keeps first
      // renders); only the presentation pointer is withdrawn.
      step.fragment_pointer = null;
      step.apply_command = null;
      step.desired = null;
    }
  }

  // §3.3 — a VALUE answer's state transition. Two things must happen here and
  // NEITHER can be left to re-judgement, which is why this pass exists rather
  // than a comment saying "the next judge will sort it out":
  //
  //   1. LIFT A STANDING DECLINE. `judgeSteps` restores a recorded decline over
  //      any non-satisfied observation for a declinable step, so a
  //      `decline -> set:` sequence would re-judge straight back to `declined`
  //      — and the reducer counts `declined` as RESOLVED, so the run could close
  //      `complete` with the operator's new choice never applied. Clearing the
  //      status here is what defeats that restoration on the next judge, because
  //      the prior map is built from these same rows.
  //   2. UN-FREEZE A CHANGED DECISION. `composeFragments.persist` returns early
  //      while a `fragment_pointer` is present, so `set:X -> set:Y` would keep
  //      X's fragment and X's apply command — the operator would be handed the
  //      superseded instruction. The freeze exists to stop a SILENT rebinding
  //      under the operator mid-apply; a new answer is the operator's own
  //      explicit act, which is precisely the exception §7 already makes for
  //      version drift ("changing the plan is an explicit act"). So a changed
  //      decision clears the render fields and the next composeFragments
  //      re-renders and re-freezes.
  //
  // The un-freeze is keyed on the decision actually CHANGING, not on the mere
  // presence of a `set:` row: re-sending the same answers file is ordinary
  // (resume takes one every time), and re-rendering identical bytes on every
  // resume would burn the freeze for nothing.
  // Current-minor by construction on both sides: these folds exist only to spot a
  // CHANGED decision within this verb, and this verb writes at the reader's own
  // minor. Provenance is judged where the document is read, not here.
  const priorStanding = foldStandingDecisions(priorChoices, { documentMinor: READER_RUN_SCHEMA.minor }).standing;
  const nextStanding = foldStandingDecisions([...(Array.isArray(priorChoices) ? priorChoices : []), ...choices], { documentMinor: READER_RUN_SCHEMA.minor }).standing;
  for (const [stepId, answer] of effective) {
    if (classifyAnswer(answer).kind !== 'set') continue;
    const step = byId.get(stepId);
    if (!step) continue;
    if (step.status === 'declined') {
      history.push({ step_id: stepId, from: 'declined', to: 'pending', reason: 'operator recorded a value answer over a standing decline', at });
      step.status = 'pending';
    }
    if (!sameDecisions(priorStanding.get(stepId), nextStanding.get(stepId))) {
      if (step.fragment_pointer || step.apply_command || step.desired != null) {
        history.push({ step_id: stepId, from: step.status, to: step.status, reason: 'value decision changed; the rendered hand-off was withdrawn so it can be re-rendered against the new decision', at });
      }
      step.fragment_pointer = null;
      step.apply_command = null;
      step.desired = null;
      // The fragment lifecycle restarts with the render; an `invalidated` stamp
      // is an independent fact about VERSION drift and is deliberately left
      // standing (judgeSteps carries it separately).
      step.fragment_applied = false;
    }
  }

  // §6.2 — declining a plugin creates a new effective custom selection and RE-RUNS
  // the hard dependency closure. The narrowing itself is the caller's (it persists the
  // result); what belongs HERE is the refusal: a decline the effective selection
  // cannot honour must stop the verb rather than be recorded as an answer that
  // quietly does nothing.
  //
  // Both sides read ONE derivation. The gate used to re-implement the retained set
  // with its own regex and its own closure call, and the two disagreed on a
  // host-scoped decline — the gate treating a single refused host row as a whole-
  // plugin removal while the narrowing (correctly) kept the plugin for its other
  // host. A validator and the thing it validates must not compute the answer twice.
  if (selection && pluginSet) {
    const refusals = effectiveSelection({ pluginSet, selection, steps }).refusedButRetained;
    if (refusals.length > 0) {
      throw new UsageError(refusals.map((r) => r.reason).join('; '));
    }
  }
  return { choices, history, effective };
}

// ---------------------------------------------------------------------------
// Stage composition — presentation + fragments (§2 table, §1.6, §10.3)
// ---------------------------------------------------------------------------

function buildStage0(probe, raw) {
  const presentation = { stage0: {} };
  for (const host of ['claude', 'codex']) {
    if (raw?.[host]?.status !== 'available') {
      raiseStage0(presentation, host, `the ${host} CLI is not present — Stage 0 is manual until ADR-0006 is superseded (§2)`);
    } else if (probe.hosts[host].marketplace !== 'registered') {
      // Running does not prove registration: a marketplace can be removed after
      // install and MUST still be probed (§1.2, §2).
      raiseStage0(presentation, host, `the agentic-plugins marketplace is not registered on ${host} (observed: ${probe.hosts[host].marketplace})`);
    }
  }
  return presentation.stage0;
}

function buildPluginActionCandidates({ effective, pluginSet, probe }) {
  const actions = [];
  for (const name of effective.plugins) {
    const hosts = pluginSet.plugins[name]?.hosts ?? [];
    for (const host of hosts) {
      // A host-scoped decline withdraws the ACTION as well as the expectation: an
      // install command for a plugin the operator refused on this host is an
      // instruction to undo their own answer.
      if (!effective.byHost[host].includes(name)) continue;
      const state = probe.hosts[host]?.plugins?.[name]?.state;
      if (state === 'missing') {
        actions.push({ host, plugin: name, action: 'install', command: host === 'claude' ? `claude plugin install ${name}@agentic-plugins` : `codex plugin add ${name}@agentic-plugins` });
      } else if (host === 'codex' && state === 'disabled') {
        actions.push({ host, plugin: name, action: 'enable', command: `codex plugin add ${name}@agentic-plugins`, note: 'failed-post-probe fallback: set enabled = true in $CODEX_HOME/config.toml only if the re-probe still observes it disabled (§2)' });
      }
    }
  }
  return actions;
}

/**
 * Read the §1.6 plan hash from a `runtime:settings` DRY-RUN (the plan half; no
 * executor flag is ever passed — test #9 pins the non-invocation of any
 * `--execute-*`). The presented command carries the hash so the executor can
 * refuse on divergence; a failed dry-run presents the command without a hash
 * plus a re-check instruction, never a fabricated one.
 */
async function fetchSettingsPlanHash({ subprocessRunner, cwd, env }) {
  const settingsPath = join(SCRIPT_DIR, 'settings.mjs');
  const result = await subprocessRunner(settingsPath, ['--repo-root', cwd, '--format', 'json'], { cwd, env, timeoutMs: 120_000 });
  if (!result?.ok) {
    return { hash: null, status: 'unavailable', reason: `settings dry-run failed (${result?.error_code ?? result?.exit_code ?? 'unknown'})` };
  }
  try {
    const report = JSON.parse(result.stdout);
    const hash = report?.plugin_management?.plan_hash ?? null;
    if (typeof hash !== 'string') {
      return { hash: null, status: 'no-hash', reason: 'the settings dry-run produced no plugin-management plan hash (probe-limited mode?)' };
    }
    // Carry settings' OWN executable-action summary alongside the hash so the
    // operator reviews the plan the hash actually seals (machine-wide, cleanup
    // included) rather than only this selection's candidates.
    const summarize = (section) => {
      const plans = Array.isArray(section?.plans) ? section.plans : [];
      return plans
        .filter((plan) => plan && typeof plan === 'object' && (plan.executable === true || plan.execution))
        .map((plan) => ({ host: plan.host ?? null, plugin: plan.plugin ?? plan.name ?? null, action: plan.action ?? null }))
        .filter((plan) => plan.plugin !== null || plan.action !== null);
    };
    const settingsActions = [...summarize(report.plugin_management), ...summarize(report.plugin_cleanup)];
    return { hash, status: 'available', reason: null, settings_actions: settingsActions };
  } catch {
    return { hash: null, status: 'unparseable', reason: 'settings dry-run output was not valid JSON' };
  }
}

function presentPluginManagement({ candidates, planHash }) {
  const base = 'runtime:settings --execute-plugin-management';
  return {
    actions: candidates,
    plan_hash: planHash.hash,
    plan_hash_status: planHash.status,
    ...(planHash.reason ? { plan_hash_reason: planHash.reason } : {}),
    // The hash's SCOPE, stated honestly (Codex Plan-verify blocker): settings
    // hashes its FULL machine plan — every plugin it manages plus any cleanup
    // actions — while `actions` above is this selection's view. The executor
    // therefore runs exactly the plan the hash seals, which can exceed these
    // candidates; the settings dry-run's own output is the authoritative
    // action list to review before executing. A selection-scoped executor
    // would need a settings-side plan filter — escalated, not absorbed here.
    settings_plan_scope: 'machine-wide (all managed plugins + cleanup), not selection-scoped',
    ...(planHash.settings_actions !== undefined ? { settings_actions: planHash.settings_actions } : {}),
    presented_command: planHash.hash ? `${base} --expected-plan-hash ${planHash.hash}` : base,
    note: planHash.hash
      ? 'The executor recomputes a fresh plan and REFUSES on hash divergence, re-presenting instead of executing a plan the operator never saw (§1.6). The hash seals settings\' machine-wide plan (including cleanup) — review the settings dry-run before executing. Bootstrap presents; it never executes (no second executor).'
      : 'No plan hash could be read from a settings dry-run; run `runtime:settings --format json` and carry its plugin_management.plan_hash as --expected-plan-hash yourself, or re-run bootstrap plan once the settings dry-run succeeds (§1.6).',
  };
}

// Fragment composition (plan/resume only — the M1 verbs; R0 verbs re-present
// recorded pointers without rendering). Every fragment carries the §10.3
// backup/verify/manual-revert guidance next to its apply command.
async function composeFragments({ homeDir, cwd, env, runId, now, steps, warnings, readersForFragments = null, standingForFragments = null }) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const persist = async (name, body, stepId, applyCommand, target, { desired = null, guidance = null } = {}) => {
    const step = byId.get(stepId);
    if (!step || step.status === 'satisfied' || step.status === 'declined' || step.status === 'not-applicable') return;
    // FREEZE-AFTER-FIRST-RENDER (statusline peer G7): once a fragment and its
    // desired expectation exist, every later resume keeps them — re-rendering
    // could silently REBIND the expectation (a changed execPath, a changed
    // mode) under the operator mid-apply. Changing the plan is an explicit
    // act: version drift clears both fields (§7 invalidation), and a fresh
    // render then re-freezes. A failed earlier write (no pointer yet) still
    // retries here.
    if (step.fragment_pointer && (desired === null || step.desired != null)) return;
    const write = await writeBootstrapFragment({ homeDir, repoRoot: cwd, runId, name, content: `${JSON.stringify(body, null, 2)}\n` });
    if (!write?.ok) {
      warnings.push(`fragment ${name} could not be persisted: ${(write?.diagnostics ?? ['unknown write failure']).join('; ')}`);
      return;
    }
    step.fragment_pointer = write.fragment.pointer;
    // A null applyCommand means the caller has none to offer; keep whatever the
    // judge computed rather than blanking it (the value steps pass null when the
    // decision is partial or already observed).
    if (applyCommand !== null) step.apply_command = applyCommand;
    // The plan-bound expectation (mode binding, Refine-verify peer): when THIS
    // run rendered a fragment, the step's `desired` records exactly what that
    // fragment asks the operator to merge — the exact probe then judges
    // against the PLAN'S expectation, not against every canonical form.
    if (desired !== null) step.desired = desired;
    // COMPOSE with any observation-time recovery instead of replacing it —
    // judgeSteps' egress recovery carries the activation procedure (which
    // env keys, placeholder-only, uid-less note) that must survive fragment
    // persistence alongside the §10.3 backup/verify guidance (Codex review).
    // §10.3 guidance is for an OPERATOR-applied fragment. A Stage-4 step is
    // applied by `runtime:settings`, so "bootstrap never reverses an operator
    // edit" describes the wrong actor there; those steps pass their own sentence.
    const sentence = guidance ?? guidance103(target);
    step.recovery = step.recovery ? `${step.recovery} ${sentence}` : sentence;
  };

  // Stage 4 — the two VALUE-BEARING config steps (§6.1.3). SEPARATE fragments,
  // one per step, and that is structural rather than stylistic: `persist` binds a
  // fragment to exactly one step id and skips a declined step, so a shared
  // fragment across two INDEPENDENTLY declinable steps could not be amended when
  // one was declined and the other answered — the freeze keeps first renders.
  //
  // What these fragments carry is INTERVIEW material, not merge material. Unlike
  // a Stage-5/6 fragment there is nothing for the operator to paste into a host
  // file: `runtime:settings` performs the write. The frozen artifact is the menu
  // the operator decides FROM — every legal value, what each does, the shipped
  // default, and what leaving a key unset means — which is exactly the thing that
  // must not be re-rendered underneath them mid-decision.
  for (const stepId of [stepIds.configSession(), stepIds.configNotifyKinds()]) {
    try {
      const step = byId.get(stepId);
      if (!step) continue;
      const keys = valueStepKeys(stepId) ?? [];
      const entry = standingForFragments?.get(stepId) ?? null;
      const fragmentName = `config-${stepId.split('.').pop().replace(/_/g, '-')}`;
      const recordedNow = entry?.mode === 'set'
        ? Object.fromEntries([...entry.decisions].sort(([a], [b]) => a.localeCompare(b)))
        : null;
      // SELF-HEALING FREEZE for the value steps.
      //
      // The fragment is written to a stable filename BEFORE the manifest update
      // that records its pointer, and there is no manifest CAS. Before this
      // change that ordering self-healed: a failed manifest write left NO
      // pointer, so the next resume re-rendered. Once a changed decision started
      // clearing the pointer to force a re-render, a failed write could instead
      // leave the OLD pointer standing over NEW bytes — and the freeze would
      // then skip rendering forever, making the mismatch permanent
      // (cross-host review, MAJOR).
      //
      // So the freeze is checked against CONTENT, not just presence: if the
      // artifact on disk does not carry the decision the ledger holds, the
      // pointer is withdrawn and persist re-renders. Cheaper than
      // content-addressed revisions and it repairs the runs that already
      // diverged. An unreadable artifact is treated as diverged, which is the
      // fail-closed direction — re-rendering costs a write, believing a
      // stale pointer costs the operator a wrong instruction.
      if (step.fragment_pointer) {
        let onDisk = null;
        try {
          onDisk = JSON.parse(await readFile(join(bootstrapFragmentsDir(homeDir, runId), `${fragmentName}.fragment`), 'utf8'));
        } catch { onDisk = null; }
        const agrees = onDisk !== null
          && JSON.stringify(onDisk.recorded_decision ?? null) === JSON.stringify(recordedNow);
        if (!agrees) {
          warnings.push(`the ${stepId} decision menu on disk did not match the recorded decision (a fragment write that outran its manifest update); it is being re-rendered.`);
          step.fragment_pointer = null;
          step.apply_command = null;
        }
      }
      await persist(fragmentName, {
        requested: true,
        step_id: stepId,
        applied_by: 'agentic-config',
        target: '~/.agentic-plugins/config.toml',
        answer_grammar: `${SET_ANSWER_PREFIX}${keys.map((k) => `${k}=<value|${UNSET}>`).join(';')}`,
        keys: keys.map((key) => valueKeyMenu(key)),
        recorded_decision: recordedNow,
        unset_means: 'the key is left UNWRITTEN and the shipped default stands — a recorded decision, not an absence. Only `runtime:settings --unset <key>` removes a key that is already written.',
        note: 'This artifact is the decision menu, not a merge target: nothing here is pasted into a host config. Answer the step through the answers file, then apply the presented runtime:settings command and resume so a live re-probe confirms it.',
      }, stepId,
      // The judge already computed the command that carries THIS decision
      // (`--notify-kinds approval,idle`, `--unset notify_kinds`). persist's
      // parameter would otherwise overwrite it with the generic form, handing
      // the operator a command that does not contain their own answer.
      // The judge's command carries THIS decision (`--notify-kinds approval,idle`,
      // `--unset notify_kinds`). When it computed NONE — a partial decision, or
      // one already observed — persist must not substitute a generic string:
      // the §6.1.3 matrix gives a partial decision `pending` plus the undecided
      // key names, and a prose-bearing `runtime:settings ... (<explanation>)` is
      // not a command the operator can run (cross-host review, MINOR).
      step.apply_command ?? null,
      '~/.agentic-plugins/config.toml',
      { guidance: `Back up ~/.agentic-plugins/config.toml before applying (copy it aside), run the presented \`runtime:settings\` command, then re-run \`runtime:bootstrap resume --latest-open\` so a live re-probe confirms the step. To undo, restore your backup — or re-answer this step, which re-renders the plan against the new decision (§6.1.3).` });
    } catch (err) {
      warnings.push(`the ${stepId} decision menu could not be built: ${err?.message ?? String(err)}`);
    }
  }

  // Stage 5 — notification (Codex notify= + tui fragments via the pure builder).
  // Each builder gets a run id in ITS OWN family's grammar — the sections carry
  // their family run-id validators, and a bootstrap-shaped id fails them.
  //
  // The fragment attaches to notify.CODEX.configured (ADR-0048 §1 split): its
  // body is exactly the Codex-side wiring, and re-observation happens through
  // that step's judge. The local-policy step (notify.configured) never carried
  // a fragment of its own — attaching this one there was the pre-split
  // imprecision the split repairs.
  // Stage 5a — the ONE decision-aware Codex [tui] fragment (ADR-0048
  // §1/§2/§2.1), persisted BEFORE the notification plan so the strip
  // decision below keys on whether the combined fragment ACTUALLY exists in
  // this run (Refine-verify peer, round 3 — a status predicate had to mirror
  // persist()'s skip conditions and drifted; the pointer after this block is
  // the existence fact itself). Review peer BLOCKER context: a
  // notifications-only block beside a combined block handed the operator two
  // competing headers, and an unconditioned combined block would re-impose a
  // key whose step the operator DECLINED — each planned key rides iff its
  // step is not declined/not-applicable; unrelated existing [tui] keys are
  // the operator's and the guidance says to keep them.
  try {
    const notifyCodexStep = byId.get(stepIds.notifyCodexConfigured());
    const slCodexStep = byId.get(stepIds.statuslineConfigured('codex'));
    const includeKey = (step) => step && step.status !== 'declined' && step.status !== 'not-applicable';
    const tuiKeys = {
      notifications: includeKey(notifyCodexStep) ? [...TUI_NOTIFICATIONS_VALUES] : null,
      statusLine: includeKey(slCodexStep) ? expectedCodexStatusLineItems() : null,
    };
    if (tuiKeys.notifications || tuiKeys.statusLine) {
      const codexTuiFragment = renderCodexTuiTableToml(tuiKeys);
      const tuiGuidance = 'Merge the rendered [tui] table into $CODEX_HOME/config.toml as THE one [tui] table — update exactly these planned keys, keep any unrelated existing [tui] keys of your own — then resume.';
      await persist('statusline-codex', {
        requested: true,
        host: 'codex',
        fragment_toml: codexTuiFragment,
        note: 'The ONE decision-aware [tui] table: each planned key (status_line, notifications) rides iff its step is not declined. The notification-plan artifact carries the notify= wiring only (its [tui] preview is stripped when this fragment exists) — merge the [tui] table from THIS block. status_line uses the closed upstream item vocabulary (host-truth §1); the agentic-6 order is ADR-0048 §2.1.',
      }, stepIds.statuslineConfigured('codex'),
      tuiGuidance,
      '$CODEX_HOME/config.toml',
      { desired: JSON.stringify(expectedCodexStatusLineItems()) });
      // The notify step keeps its OWN fragment pointer (the notify= wiring
      // artifact — its [tui] preview is stripped at its persist below when
      // this fragment exists), so this combined fragment is the single [tui]
      // source for the run whenever it renders.
    }
  } catch (err) {
    warnings.push(`codex [tui] fragment could not be built: ${err?.message ?? String(err)}`);
  }

  try {
    const gathered = await gatherCodexNotificationInputs({ homeDir, env });
    const { section } = buildCodexNotificationPlanSection({ gathered, now: new Date(now), runId: makeNotificationRunId(now) });
    // The [tui] preview is STRIPPED from this artifact exactly when the
    // combined statusline-codex fragment is the run's PRESENTED [tui]
    // source: the combined fragment is the ONE decision-aware [tui] table
    // (Review peer BLOCKER), and persisting the builder's notifications-only
    // preview beside it would hand the operator two [tui] blocks with
    // competing guidance. Two facts compose the predicate (Refine-verify
    // peer, rounds 2-4):
    //   - fragment_pointer — the Stage-5a block ABOVE persisted (or kept)
    //     the combined fragment: covers a fresh render, a frozen fragment
    //     from an earlier resume, and a failed write (pointer absent → the
    //     preview stays the presented source and the routing note cannot
    //     dangle). NB the pointer is a PRESENTATION fact, not a
    //     physical-file fact — after §7 clears it, a previous file can
    //     linger unpresented until the re-render lands.
    //   - step-alive — a DECLINED/not-applicable statusline step keeps its
    //     historical pointer (persist() skips dead steps without clearing
    //     fields), but its frozen fragment still carries the declined
    //     status_line key: routing the operator there would make a refused
    //     key authoritative (round-4 High). A dead step's combined fragment
    //     is history, never the presented source.
    const slStepForTui = byId.get(stepIds.statuslineConfigured('codex'));
    const slStepAliveForTui = Boolean(slStepForTui)
      && slStepForTui.status !== 'declined' && slStepForTui.status !== 'not-applicable';
    const combinedCarriesTui = slStepAliveForTui && Boolean(slStepForTui.fragment_pointer);
    // Captured BEFORE the persist below: a pre-existing pointer means the
    // notify artifact is FROZEN (persist() keeps first renders) and this
    // strip cannot reach the on-disk bytes.
    const notifyPointerFrozen = Boolean(byId.get(stepIds.notifyCodexConfigured())?.fragment_pointer);
    const notifySection = combinedCarriesTui
      ? {
        ...section,
        fragments: { ...section.fragments, tui_notifications_toml: null },
        // NB: this note deliberately spells the table dotted (`tui.notifications`)
        // — a literal `[tui]` header may appear in exactly ONE artifact per run
        // (the combined statusline-codex fragment), and the sweep test pins that.
        tui_note: 'The tui.notifications key rides in the statusline-codex combined fragment (the ONE tui table for this run) — merge it from there, not from this artifact.',
      }
      : section;
    await persist('notification-plan', notifySection, stepIds.notifyCodexConfigured(),
      'Merge the rendered notify fragment into $CODEX_HOME/config.toml (see the fragment body), then resume.',
      '$CODEX_HOME/config.toml',
      { desired: Array.isArray(section.expected_notify_argv) ? JSON.stringify(section.expected_notify_argv) : null });
    // Frozen two-carrier honesty (Refine-verify peer, round 3): when the
    // combined fragment carries [tui] but the notify artifact was frozen by
    // an EARLIER plan state that kept its preview (e.g. the statusline step
    // re-transitioned satisfied→pending across resumes), the on-disk
    // artifact still shows two [tui] blocks. The freeze is deliberate
    // (G7 — no silent rewrite under the operator mid-apply; see the
    // fragment-freeze follow-up), so runtime NAMES the supersession instead
    // of hiding it.
    if (combinedCarriesTui && notifyPointerFrozen) {
      try {
        // Parse and inspect the PREVIEW FIELD itself — a whole-text regex
        // false-positives on the builder's `tui_warning` prose, which
        // legitimately contains the literal `[tui]` while the preview is
        // stripped (Refine-verify peer, round 4).
        const frozen = JSON.parse(await readFile(join(bootstrapFragmentsDir(homeDir, runId), 'notification-plan.fragment'), 'utf8'));
        if (frozen?.fragments?.tui_notifications_toml) {
          warnings.push('the frozen notification-plan artifact still carries a [tui] preview from an earlier plan state, while the combined statusline-codex fragment is now the [tui] source — merge ONLY the combined [tui] table; the frozen preview is superseded (fragment freeze keeps first renders; see the fragment-freeze follow-up).');
        }
      } catch {
        // A frozen artifact that cannot be read/parsed might still carry the
        // preview — parse failure must not SILENCE the supersession call
        // (contract: named, non-silent; Refine-verify round 5). Warn
        // conservatively instead of guessing.
        warnings.push('the frozen notification-plan artifact could not be parsed while the combined statusline-codex fragment is the presented [tui] source — treat the combined [tui] table as the ONE source and inspect the artifact by hand (conservative supersession warning).');
      }
    } else if (!combinedCarriesTui && notifyPointerFrozen) {
      // The strip is a DERIVED state, valid only while the combined fragment
      // is the presented source. If that authority lapsed (the statusline
      // step was declined, or its pointer cleared) while the frozen notify
      // artifact is still stripped, the run presents NO [tui] source
      // (Refine-verify round 5). Runtime NAMES that state instead of
      // rewriting the frozen artifact — a round-5 restore-rewrite attempt
      // opened a fragment-vs-manifest commit-ordering hole (round-6 High: a
      // restored file could land while the manifest update carrying the
      // authority withdrawal failed, yielding two physical sources under a
      // live combined pointer), and there is no manifest CAS transaction to
      // close it. Abandon + re-plan is the honest recovery; the underlying
      // reconciliation is the fragment-freeze follow-up.
      try {
        const frozen = JSON.parse(await readFile(join(bootstrapFragmentsDir(homeDir, runId), 'notification-plan.fragment'), 'utf8'));
        if (frozen?.fragments && frozen.fragments.tui_notifications_toml == null) {
          warnings.push('the combined statusline-codex fragment is no longer the presented [tui] source, and the frozen notification-plan artifact was stripped while it was — this run currently presents NO [tui] source (fragment freeze keeps first renders). Re-plan (abandon + plan) to regain one; see the fragment-freeze follow-up.');
        }
      } catch {
        warnings.push('the frozen notification-plan artifact could not be parsed while no combined [tui] fragment is presented — the run may present no [tui] source; re-plan (abandon + plan) to regain one (fail-closed).');
      }
    }
  } catch (err) {
    warnings.push(`notification plan could not be built: ${err?.message ?? String(err)}`);
  }

  // Stage 5 — statusline, Claude side + the unconditional shim artifact
  // (ADR-0048 §1/§2/§2.1 via the one policy in lib/statusline-plan.mjs).
  // The Codex [tui] fragment moved to Stage 5a ABOVE the notification plan
  // so the preview-strip decision can key on its actual existence.
  try {
    const shim = renderAgenticStatuslineShim();
    // The statusline shim is opted into by the very act of planning this step,
    // so its absence IS actionable here (unlike the conditional chain receiver).
    const receiverInventory = inspectInstalledReceivers({
      installDir: `${homeDir}/.agentic-plugins/bin`,
      expected: ['agentic-statusline.mjs'],
    });
    const statuslineInstalled = receiverInventory.receivers.find((entry) => entry.kind === 'agentic-statusline.mjs') ?? null;
    const inlineGate = evaluateInlineSufficiency();
    const claudeExpected = expectedClaudeStatuslineCommand({ homeDir });
    const claudeExisting = readersForFragments?.statuslineClaude ?? { readable: true, present: false };
    const claudeClassified = classifyExistingClaudeStatusline({ existing: claudeExisting, expectedCommand: claudeExpected });
    // The settings TARGET is the same file the probe reads (Review peer MAJOR:
    // CLAUDE_CONFIG_DIR relocates ~/.claude — apply guidance must not point at
    // a file resume never probes).
    const claudeSettingsTarget = `${resolveClaudeConfigDir(env, homeDir).replace(/\\/g, '/')}/settings.json`;
    // Unreadable settings withhold the REPLACEMENT fragment (Review peer
    // MINOR): rendering an apply command over a file nobody could read
    // invites overwriting an unseen foreign command. The non-gating shim
    // artifact below still delivers.
    if (claudeExisting.readable !== false) await persist('statusline-claude', {
      requested: true,
      host: 'claude',
      fragment_json: renderClaudeStatuslineFragmentJson({ homeDir }),
      shim: {
        install_path: statuslineShimInstallPath({ homeDir }),
        sha256: shim.sha256,
        body: shim.body,
        // What is ACTUALLY at that path right now. The step above proves
        // settings-level configuration, which a legacy or absent shim satisfies
        // just as well as a current one — so without this the operator sees a
        // green step and a fresh hash while running frozen bytes. Read-only:
        // the file is classified from its bytes, never executed.
        installed: statuslineInstalled,
      },
      inline_sufficiency: inlineGate,
      existing: { observation: claudeClassified.observation, offered_resolutions: claudeClassified.offered_resolutions, note: claudeClassified.note },
      configured_is_not_active: 'A statusLine entry proves configuration only: workspace trust, disableAllHooks, and CLAUDE_CODE_SAFE_MODE still gate execution (host-truth §3).',
    }, stepIds.statuslineConfigured('claude'),
    `Install the shim at ${statuslineShimInstallPath({ homeDir })} (verify sha256 ${shim.sha256.slice(0, 12)}…), merge the statusLine fragment into ${claudeSettingsTarget}, then resume.`,
    claudeSettingsTarget,
    { desired: JSON.stringify([claudeExpected]) });

    // NON-GATING shim delivery (peer G10): a canonical command can be
    // satisfied while the shim on disk is missing or stale — persist() skips
    // satisfied steps, so the CURRENT shim body + hash are written
    // unconditionally as their own artifact. Never step-gating: the step is
    // "configuration observed", and this file is the operator's refresh
    // material (back up the old shim, install, run a self-test echo, or
    // revert by restoring the backup).
    const shimWrite = await writeBootstrapFragment({ homeDir, repoRoot: cwd, runId, name: 'statusline-shim', content: shim.body });
    if (!shimWrite?.ok) warnings.push(`statusline shim artifact could not be persisted: ${(shimWrite?.diagnostics ?? ['unknown write failure']).join('; ')}`);
  } catch (err) {
    warnings.push(`statusline plans could not be built: ${err?.message ?? String(err)}`);
  }

  // Stage 5 — egress launcher (ADR-0041 §12 state-aware runbook via the pure builder).
  try {
    const gathered = await gatherEgressLauncherInputs({ repoRoot: cwd, homeDir, env });
    const { section } = buildEgressLauncherPlanSection({ gathered, host: 'claude', now: new Date(now), runId: makeEgressLauncherRunId(now) });
    // Apply command + §10.3 backup target must name the layout THIS machine
    // can honor (env-only where the verified-local reader fail-closes — e.g.
    // Windows); the helper owns the branch so runbook and guidance can't drift.
    const guidance = egressFragmentApplyGuidance(gathered.activation);
    await persist('egress-launcher-plan', section, stepIds.egressConfigured(),
      guidance.apply_command, guidance.target);
  } catch (err) {
    warnings.push(`egress launcher plan could not be built: ${err?.message ?? String(err)}`);
  }

  // Stage 6 — BOTH permission plans (ADR-0038 first-class Claude AND Codex).
  try {
    const gathered = await gatherPermissionPlanInputs({ repoRoot: cwd, homeDir, env, maxFiles: 100, maxFileBytes: 8 * 1024 * 1024 });
    const built = buildPermissionPlanSection({ gathered, now: new Date(now), runId: makePermissionRunId(now) });
    await persist('permission-claude', built.claude, stepIds.permissionApplied('claude'),
      'Apply the safety-graded fragment to ~/.claude/settings.json yourself (render-and-confirm; §4.5 safety grading: bypassPermissions is never a default), then resume.',
      '~/.claude/settings.json');
    await persist('permission-codex', built.codex, stepIds.permissionApplied('codex'),
      'Apply the approval_policy / sandbox_mode fragment to $CODEX_HOME/config.toml yourself (never approval_policy="never" or danger-full-access as defaults), then resume.',
      '$CODEX_HOME/config.toml');
  } catch (err) {
    warnings.push(`permission plans could not be built: ${err?.message ?? String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Run selection (§3 semantics, following footer-contract.md)
// ---------------------------------------------------------------------------

async function selectRun({ homeDir, opts, defaultSelector, validateRun }) {
  const scan = await scanBootstrapRuns({ homeDir });
  if (scan.status === 'blocked') {
    return { error: `Cannot read the bootstrap family (${scan.error}).`, exitCode: EXIT.UNEXPECTED };
  }
  const wanted = opts.run_id ? 'run-id' : opts.latest ? 'latest' : opts.latest_open ? 'latest-open' : defaultSelector;
  let run = null;
  if (wanted === 'run-id') {
    run = scan.runs.find((r) => r.run_id === opts.run_id) ?? null;
    if (!run) return { error: `No run ${opts.run_id} exists.`, exitCode: EXIT.NO_ACTIVE_RUN };
  } else if (wanted === 'latest') {
    run = scan.runs[0] ?? null;
  } else {
    run = scan.runs.find((r) => r.status === 'open') ?? null;
  }
  if (!run) return { error: 'no-active-run', exitCode: EXIT.NO_ACTIVE_RUN };
  const manifestPath = join(homeDir, '.agentic-plugins', 'runs', 'bootstrap', run.run_id, 'run.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    // A read failure carries an fs `code`; a PARSE failure does not, and its
    // message quotes the manifest's own bytes (§3.2). The two are separated
    // rather than collapsed through `??`, which fell through to the quoting
    // message exactly when the document was the untrusted thing.
    const cause = err?.code ? `${err.code}` : `not valid JSON${jsonParsePosition(err)}`;
    return { error: `Run ${run.run_id} has an unreadable manifest (${cause}); close it with \`abandon ${run.run_id}\`.`, exitCode: EXIT.UNEXPECTED };
  }
  // ADR-0048 §3 — the selected manifest feeds every downstream reduction, so it
  // must be schema-valid BEFORE anything reads a field from it. Fail-closed with
  // the abandon escape hatch (abandon replaces an invalid record with a valid
  // tombstone); silently reducing over an invalid body is how a forged or
  // half-written run.json becomes a completion verdict.
  const verdict = validateRun(manifest);
  if (!verdict.ok) {
    return { error: `Run ${run.run_id} has a schema-invalid manifest (${verdict.errors.slice(0, 3).join('; ')}); close it with \`abandon ${run.run_id}\` and start a new plan.`, exitCode: EXIT.UNEXPECTED };
  }
  // The embedded run_id must NAME the selected directory (Codex review
  // BLOCKER): a valid manifest for run B sitting inside directory A would
  // otherwise route every downstream read — proof/ read-back included — to
  // B's evidence while claiming to report on A.
  if (manifest.run_id !== run.run_id) {
    return { error: `Run directory ${run.run_id} contains a manifest naming ${manifest.run_id} — the record and its home disagree, so neither can be trusted. Close it with \`abandon ${run.run_id}\`.`, exitCode: EXIT.UNEXPECTED };
  }
  // Duplicate step ids are schema-valid (an array cannot forbid them) but
  // collapse inconsistently downstream (first-wins .find vs last-wins Map —
  // Codex review MAJOR): refuse them at the selection boundary.
  const stepIdCounts = new Map();
  for (const s of manifest.steps ?? []) {
    if (typeof s?.id === 'string') stepIdCounts.set(s.id, (stepIdCounts.get(s.id) ?? 0) + 1);
  }
  const duplicatedStepIds = [...stepIdCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();
  if (duplicatedStepIds.length > 0) {
    return { error: `Run ${run.run_id} records duplicate step id(s) ${duplicatedStepIds.join(', ')} — duplicate rows collapse ambiguously and are refused. Close it with \`abandon ${run.run_id}\`.`, exitCode: EXIT.UNEXPECTED };
  }
  // §4.1 validator warnings SURFACE (Codex review MAJOR): a future-minor
  // document's ignored scalars must be visible to the operator, not silently
  // dropped at the one boundary every verb reads through.
  //
  // D1 §3.2 — the validator now DISPLAYS at most 16 of them, which would make
  // "16 ignored keys" indistinguishable from "16 ignored keys out of four
  // thousand". A bounded list that does not admit it was bounded reads as the
  // whole story, so the omission is stated with the totals the validator kept.
  const warnings = [...(verdict.warnings ?? [])];
  if (verdict.omitted) {
    warnings.push(`this manifest produced ${verdict.warning_count} validation warning(s) and ${verdict.error_count} error(s); only the first ${FINDINGS_MAX_PER_ARTIFACT} of each are shown (§3.2 display bound). The findings are content-free by design — read the run artifact directly to inspect the document itself.`);
  }
  return { run, manifest, warnings };
}

// ---------------------------------------------------------------------------
// Shared verb plumbing
// ---------------------------------------------------------------------------

function defaultRunner(name, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };
    let child;
    try {
      child = spawn(name, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ ok: false, exit_code: null, error_code: err?.code ?? 'spawn-failed', stdout: '', stderr: '', error_message: err?.message });
      return;
    }
    const timer = setTimeout(() => {
      // SIGTERM on the self-spawned child only — the one registered kill form
      // (ADR-0035 §4; the executor-guard kill-gate rejects anything else).
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      finish({ ok: false, exit_code: null, error_code: 'timeout', stdout, stderr, error_message: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, exit_code: null, error_code: err?.code ?? 'spawn-failed', stdout, stderr, error_message: err?.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, exit_code: code, error_code: null, stdout, stderr });
    });
  });
}

function defaultSubprocessRunner(scriptPath, args, { cwd, env, timeoutMs }) {
  return defaultRunner(process.execPath, [scriptPath, ...args], { cwd, env, timeoutMs });
}

async function loadContext(ctx) {
  const pluginSet = await loadPluginSet({ pluginRoot: ctx.pluginRoot });
  const setVerdict = validatePluginSet(pluginSet);
  if (!setVerdict.ok) {
    throw new Error(`packaged plugin-set.json is invalid (a runtime packaging bug): ${setVerdict.errors.join('; ')}`);
  }
  const validateRun = await makeValidator('runtime-bootstrap-run', { pluginRoot: ctx.pluginRoot });
  const validateProfile = await makeValidator('agentic-machine-profile', { pluginRoot: ctx.pluginRoot });
  const profileSchema = await loadSchema('agentic-machine-profile', { pluginRoot: ctx.pluginRoot });
  return { pluginSet, validateRun, validateProfile, profileSchema };
}

async function probeNow(ctx) {
  const raw = await probeMachineHostState({
    homeDir: ctx.homeDir,
    // Scrubbed: the host-CLI probes are control-plane children (ADR-0048 §4).
    env: scrubbedControlPlaneEnv(ctx.env),
    runner: ctx.runner,
    // NEUTRAL cwd — never the caller's repository (§1.1).
    cwd: tmpdir(),
  });
  const probe = serializeProbe({ raw, runtimeVersion: RUNTIME_VERSION, now: ctx.now });
  return { raw, probe };
}

async function readUserGlobalReaders(ctx) {
  // ONE Claude settings read for BOTH projections (Review peer MAJOR: two
  // reads could observe an atomic replacement in between and report mutually
  // inconsistent permission/statusline facts under one probe timestamp).
  // ONE read per FILE, projected per consumer — the rule the Claude settings
  // snapshot already followed, now applied to the two files that still broke it
  // (cross-host Review peer, MAJOR). `model_effort` and `notify` are two families
  // of ~/.agentic-plugins/config.toml; Codex permission and the Codex
  // notify/statusline judges are two readers of $CODEX_HOME/config.toml. Read
  // twice, an atomic replacement between the reads let config rows be satisfied
  // by two different versions of one file — and a run could terminalize
  // `complete` on a combination neither version supports.
  //
  // COVERAGE, stated rather than claimed: splitting these back into separate
  // reads is a mutant NO test kills. Observing it needs a replacement landing
  // BETWEEN two reads, and `readTextIfExists` is not injectable through
  // `runBootstrap`, so the property is structural — the tests pin that the
  // projections equal the readers they replaced, not that only one read happens.
  // A future reader-injection seam would make it testable; until then the guard
  // is this comment and the shape of the code.
  const [claudeSettingsSnapshot, runtimeConfigSnapshot, codexNotifyGathered] = await Promise.all([
    readUserGlobalClaudeSettings({ homeDir: ctx.homeDir, env: ctx.env }),
    readUserGlobalRuntimeConfig({ homeDir: ctx.homeDir }),
    // ADR-0048 §1 — the Codex-side notify WIRING for notify.codex.configured,
    // gathered here (rather than below) because its read is now ALSO the
    // permission judge's bytes.
    gatherCodexNotificationInputs({ homeDir: ctx.homeDir, env: ctx.env }),
  ]);
  const modelEffort = projectModelEffort(runtimeConfigSnapshot);
  const notify = projectNotify(runtimeConfigSnapshot);
  // The THIRD family of the same one snapshot (profile 1.2). Projected here rather
  // than read separately for the reason stated above: `model_effort`, `notify` and
  // `session` are three families of ONE file, and a second read could observe an
  // atomic replacement between them.
  const session = projectSession(runtimeConfigSnapshot);
  // §6.1.3 — which session keys are currently overridden by env. Read from the
  // SAME env the rest of this reader resolves paths with, so the reported
  // shadowing describes the process the judge is running in. Presence alone is
  // the fact (an env key set to anything wins over user-global at ADR-0045 §7's
  // resolution order); the VALUE is deliberately not captured — the step does
  // not judge it, and an env value is unclamped operator input.
  // PRESENCE, matching `loadEntryBriefConfig`'s own rule: an env var that EXISTS
  // with an empty or whitespace value reaches the validator and fails closed —
  // it never falls through to the user layer as if absent. Testing `length > 0`
  // made the comment beside it false and omitted a real override: with
  // `AGENTIC_ENTRY_BRIEF=` exported, the entry-brief loader fail-closes while
  // this step reported a clean satisfied posture and no shadow at all
  // (both review lanes).
  const sessionEnvShadow = Object.fromEntries(
    Object.entries(ENTRY_BRIEF_ENV_KEYS).map(([key, envName]) => [key, typeof ctx.env?.[envName] === 'string']),
  );
  // The override flag is derived from the SAME env the gather resolved
  // $CODEX_HOME with, so the reported provenance describes the bytes read.
  // Provenance comes from the GATHER that produced the bytes, not from a second
  // look at `ctx.env`: the env object is caller-supplied on the programmatic
  // surface, and re-deriving it could label an override-path read as the default
  // one (Refine-verify peer).
  const codexPermission = projectCodexPermission(codexNotifyGathered.read, {
    codexHomeSource: codexNotifyGathered.codexHomeSource,
  });
  const claudePermission = projectClaudePermission(claudeSettingsSnapshot);
  const egress = readUserGlobalEgress({ repoRoot: ctx.cwd, homeDir: ctx.homeDir, env: ctx.env });
  // Step judgement needs ACTIVATION semantics (the named E1 checker) alongside
  // the credential-independent export shape above: `egress` feeds the §4.4
  // machine profile (channel/recipient survive a missing per-machine token),
  // while `egressActivation` feeds egress.configured (channel alone must NOT
  // satisfy — the false-pass this split repairs). Two readers, two questions.
  const egressActivation = loadEgressActivation({ repoRoot: ctx.cwd, homeDir: ctx.homeDir, env: ctx.env });
  // The gather above (hoisted so the permission judge shares its bytes) is the
  // same notification-plan gather the Stage-5 fragment builder uses — §1.1 keeps
  // bootstrap off the repo-scoped state-readers seam (test #1) — and it is read
  // once per probe alongside every other user-global reader because judgeSteps
  // is synchronous. Shape:
  //   readable  — the config file could be read (missing file reads as an
  //               empty config: readable, nothing present);
  //   present   — a top-level `notify =` key exists;
  //   argv      — the parsed string elements, or null when the value is
  //               present but not a parseable string array (fail-safe null
  //               from the TOML scanner — never a guess).
  const codexNotifyRead = codexNotifyGathered.read;
  // ADR-0048 statusline slice — both statusline probes, gathered here because
  // judgeSteps is synchronous. Claude projects the ONE shared settings
  // snapshot (peer G9: permission and statusline judge the same bytes);
  // Codex reuses the SAME config read the notify gather already performed.
  const statuslineClaude = {
    ...projectClaudeStatusline(claudeSettingsSnapshot),
    expectedCommand: expectedClaudeStatuslineCommand({ homeDir: ctx.homeDir }),
  };
  const statuslineCodexParsed = codexNotifyRead.ok ? parseCodexNotifyConfigToml(codexNotifyRead.text) : null;
  const statuslineCodex = {
    readable: codexNotifyRead.ok || codexNotifyRead.reason === 'ENOENT' || codexNotifyRead.reason === 'ENOTDIR',
    present: statuslineCodexParsed?.tuiStatusLine?.present === true,
    items: statuslineCodexParsed?.tuiStatusLine?.values ?? null,
    expectedItems: expectedCodexStatusLineItems(),
  };
  // The EXACT canonical argvs this machine's rendered fragment would carry
  // (notify-axis slice): direct mode points at the shuttle, wrapper-chain mode
  // at the chain script — a merged config matching EITHER is the canonical
  // wiring, observed. expectedCodexNotifyArgv is the same single source the
  // fragment renderer consumes, so probe and fragment cannot drift.
  const codexNotifyExpected = [
    expectedCodexNotifyArgv({ receiverPath: codexNotifyGathered.installPaths.shuttle }),
    expectedCodexNotifyArgv({ receiverPath: codexNotifyGathered.installPaths.chain }),
  ];
  // ADR-0040 §4b — the SECOND half of this step's Codex-side attention wiring.
  // `notify =` fires only on agent-turn-complete; `[tui] notifications` is the
  // only channel that carries approval-requested. It is projected here, from
  // the SAME parse the notify half uses, because the contract already calls it
  // a runtime-planned key and the fragment builder already binds it to this
  // step's decision — the judge was the last component that did not observe it.
  // `form` (never `raw`) is what the judge may interpret.
  const NO_TUI_NOTIFICATIONS = { present: false, form: 'absent', values: null };
  let codexNotify;
  if (codexNotifyRead.ok) {
    const parsed = parseCodexNotifyConfigToml(codexNotifyRead.text);
    codexNotify = {
      readable: true,
      present: parsed.notify.present,
      argv: parsed.notify.values ?? null,
      expected: codexNotifyExpected,
      tuiNotifications: {
        present: parsed.tuiNotifications.present,
        form: parsed.tuiNotifications.form,
        values: parsed.tuiNotifications.values ?? null,
      },
    };
  } else if (codexNotifyRead.reason === 'ENOENT' || codexNotifyRead.reason === 'ENOTDIR') {
    codexNotify = { readable: true, present: false, argv: null, expected: codexNotifyExpected, tuiNotifications: { ...NO_TUI_NOTIFICATIONS } };
  } else {
    codexNotify = { readable: false, present: false, argv: null, expected: codexNotifyExpected, tuiNotifications: { ...NO_TUI_NOTIFICATIONS } };
  }
  return { modelEffort, notify, session, sessionEnvShadow, claudePermission, codexPermission, egress, egressActivation, codexNotify, statuslineClaude, statuslineCodex };
}

// ADR-0048 §4 — CONTROL-PLANE child environments are scrubbed at the point of
// spawn: the host probes, the settings dry-run, and the read-only doctor fetch
// have no business holding the egress credential. The ONE exception is the
// explicitly-executed proof path (executeProofViaDoctor), whose attention
// hooks must egress — §4 names that inheritance a documented exception, not a
// loophole. In-process readers (the E1 activation checker, the user-global
// config reads) keep the raw env: they are the named readers, not children.
function scrubbedControlPlaneEnv(env) {
  const out = { ...(env ?? {}) };
  delete out[EGRESS_CREDENTIAL_ENV_VAR];
  return out;
}

// ADR-0048 §3 / D0.3 — the CURRENT sanitized activation identity for the
// egress-provider-ack freshness equality. Derived from the E1 activation
// checker's enum-clamped channel + recipient + the credential env var NAME —
// never the credential value (rotation is invisible here by design; the
// contract §8.1 documents that limit). Null when no activation is configured,
// which the reducer reads as "stale: recorded against an activation this
// machine no longer carries".
function currentActivationFingerprintOf(readers) {
  const activation = readers?.egressActivation;
  if (!activation?.active) return null;
  return deriveActivationFingerprint({
    channel: activation.channel,
    recipient: activation.recipient,
    credentialEnvVar: EGRESS_CREDENTIAL_ENV_VAR,
  });
}

function resolveSelection({ opts, pluginSet, seededSelection = null }) {
  const bundle = opts.bundle ?? seededSelection?.bundle ?? 'base';
  let desired;
  if (bundle === 'custom') {
    desired = opts.plugins
      ? [...new Set(opts.plugins.split(',').map((s) => s.trim()).filter(Boolean))].sort()
      : [...(seededSelection?.desired ?? [])].sort();
    if (desired.length === 0) throw new UsageError('--bundle custom REQUIRES --plugins <csv> (§3)');
    const unknown = desired.filter((name) => !(name in pluginSet.plugins));
    if (unknown.length > 0) throw new UsageError(`unknown plugin(s) in --plugins: ${unknown.join(', ')}`);
    // §6.2 — companions (and runtime) are mandatory in EVERY selection,
    // including custom; a selection without them defines an unreachable
    // terminal state, so it is rejected rather than silently repaired.
    const missingMandatory = MANDATORY_PLUGINS.filter((name) => !desired.includes(name));
    if (missingMandatory.length > 0) {
      throw new UsageError(`a custom selection may not omit ${missingMandatory.join(', ')} (§6.2 — mandatory in every selection; deep-peer-smoke would be unreachable)`);
    }
  } else {
    if (!BUNDLE_NAMES.includes(bundle)) {
      throw new UsageError(`unknown bundle '${bundle}' (§9: ${BUNDLE_NAMES.join(' | ')} | custom)`);
    }
    desired = resolveBundle(pluginSet, bundle);
  }
  const violations = hardClosureViolations(pluginSet, desired);
  if (violations.length > 0) {
    const detail = violations.map((v) => v.reason === 'unknown-plugin' ? `${v.plugin} is not a known plugin` : `${v.plugin} hard-requires ${v.requires} on ${v.host}`).join('; ');
    throw new UsageError(`selection violates the §9.1 hard dependency closure: ${detail}`);
  }
  const softWarnings = [];
  for (const name of desired) {
    for (const edge of pluginSet.plugins[name]?.soft_requires ?? []) {
      if (!desired.includes(edge.name)) {
        softWarnings.push(`${name} soft-requires ${edge.name} (${(edge.hosts ?? []).join('/')}) — the selection works without it but is materially degraded (§9.1)`);
      }
    }
  }
  const excluded = PLUGIN_NAMES.filter((name) => !desired.includes(name)).sort();
  return { selection: { bundle, desired, excluded }, softWarnings };
}

// `recordedAttestation` is the READ-BACK proof/hook-attestation.json record —
// never the manifest's reduced completion cache (Codex review MAJOR: judging
// the step from the cache stranded a run whose attestation file landed but
// whose manifest persist failed — every later resume saw the recorded proof,
// skipped refreshing it, and kept the step pending off the stale cache).
/**
 * The previous-state map judgeSteps judges against. ONE implementation, because
 * both callers must normalize identically: reprobeAgainstRun's first pass, and
 * resume's post-import re-judge. A second hand-rolled copy is how the two drift.
 */
function priorJudgeMapOf(stepList) {
  return new Map((stepList ?? []).map((s) => {
    // A LEGACY-MIGRATION strip, and the rationale belongs here rather than at a
    // call site: a pre-split run carried the Codex notification fragment on
    // `notify.configured` (the local-policy step); post-split it belongs to
    // `notify.codex.configured`, and carrying the stale pointer forward would
    // keep presenting the Codex merge command on the wrong step — and could mark
    // that unrelated fragment applied when the LOCAL policy satisfies (Codex
    // review MINOR). composeFragments re-renders it onto the right step on the
    // same resume.
    //
    // The comment was written at the ONE call site this was inlined in and was
    // left behind when the helper was extracted (`b55ce53`), which left an
    // unconditional, permanently-firing strip reading as if it had no reason.
    // It is restored here because the rule is a property of the helper, not of
    // any caller: it fires on every run forever, so a future fragment attached
    // to `notify.configured` would vanish on reprobe with nothing to explain it.
    if (s.id === stepIds.notifyConfigured() && (s.fragment_pointer || s.apply_command)) {
      const { fragment_pointer, apply_command, fragment_applied, ...rest } = s;
      return [s.id, rest];
    }
    // A DECLINED provenance carries no render state into judgement either
    // (Refine-verify round 6): a legacy declined step's frozen `desired`
    // would otherwise mode-bind the exact probe and demote a legitimate
    // satisfying observation to manual-follow-up — the refused plan's
    // expectation blocking the operator's own manual configuration is one
    // more resurrection shape. The entry assembly drops the same fields
    // post-judgement (belt-and-braces).
    if (s.status === 'declined' && (s.fragment_pointer || s.apply_command || s.desired != null)) {
      const { fragment_pointer, apply_command, desired, fragment_applied, ...rest } = s;
      return [s.id, rest];
    }
    return [s.id, s];
  }));
}

/**
 * The operator-facing sentence for a lapsed refusal. ONE wording, because four
 * verbs surface it and a second copy is how they would drift; the resume-side
 * post-executor convergence says the same thing about a later window.
 */
function selectionRestoredWarnings(selectionRestored, { window, consequence }) {
  return (selectionRestored ?? []).map(({ host, plugins }) =>
    `${plugins.join(', ')} was refused on ${host} but is observed installed there ${window}; the refusal no longer follows from the run's own rows (§6.2 — an observation clears a decline; re-plan if the refusal was the intent). ${consequence}`);
}

/**
 * The Stage-6 permission fragment's APPLIED state, per host, read off step rows.
 * ONE implementation for the same reason as `priorJudgeMapOf` above: it is a
 * judgement INPUT — `deriveExpectedSteps` reads it to decide whether
 * `proof.permission` applies at all — and both derivation sites (the reprobe's
 * second pass, and resume's final-snapshot reconstruction) must read it
 * identically or the two expectations drift over the same rows.
 */
function permissionFragmentAppliedFrom(rows) {
  return Object.fromEntries(['claude', 'codex'].map((h) => [
    h,
    (rows ?? []).find((s) => s.id === stepIds.permissionApplied(h))?.fragment_applied === true,
  ]));
}

// A parsed JSON value is only usable as a report/record when it is a plain
// object: `null`, `false`, `0`, `""` and arrays all survive JSON.parse and would
// otherwise slip through truthiness checks unremarked.
// `runtime:doctor` reports its findings through its exit code (doctor.mjs EXIT).
// That makes `result.ok` — which is only `exit_code === 0` — the wrong gate for
// both sites below: a machine with a blocked proof or an unauthenticated host is
// exactly the machine bootstrap is here to fix, and discarding its report would
// turn a diagnosis into "doctor failed (unknown)". The rule is therefore: PARSE
// STDOUT FIRST; the exit code is a classifier, not a gate. Only an unparseable
// or absent report is a real failure, and only DOCTOR_EXIT.RECORD_FAILED means
// the run produced no artifact for a proof record to link by hash.
//
// The constant is restated rather than imported ON PURPOSE: the §1.1 machine
// seam forbids this file from importing the repo-scoped doctor module at all,
// and `tests/runtime/test-bootstrap-cli.mjs` enforces that with a whole-source
// scan. The value is additionally cross-checked against the report field below,
// so a drift in the number alone cannot silently change the verdict.
const DOCTOR_EXIT = Object.freeze({ RECORD_FAILED: 40 });

// The exits that mean "a complete report is on stdout". Everything else — a
// crash, a usage error, a signal, a future code this runtime has never heard of
// — is refused even when stdout happens to hold parseable JSON, because a
// buffered fragment from a child that then died is not a diagnosis. Restricting
// to a KNOWN set is what keeps "parse first" from degrading into "never fail".
const DOCTOR_REPORT_BEARING_EXITS = Object.freeze([0, 10, 20, 30, 40]);

function readDoctorSubprocessReport(result) {
  const producedOutput = typeof result?.stdout === 'string' && result.stdout.trim() !== '';
  const failure = result?.error_code ?? result?.exit_code ?? 'unknown';
  // `exit_code` is null on a timeout or spawn error; treat only a real integer
  // as a code, so a missing one can never accidentally match the allowlist.
  const exitCode = Number.isInteger(result?.exit_code) ? result.exit_code : null;
  const refuse = (diagnostic) => ({ report: null, recordFailed: false, diagnostic });

  if (!producedOutput) {
    return refuse(`runtime:doctor could not be run (${failure})`);
  }
  if (exitCode === null || !DOCTOR_REPORT_BEARING_EXITS.includes(exitCode)) {
    return refuse(`runtime:doctor exited ${failure}, which carries no report contract`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return refuse(`runtime:doctor output was not valid JSON (exit ${failure})`);
  }
  // A successful parse that is not an OBJECT is not a report: `null`, `false`,
  // `0` and `""` all parse, and each would slip past every truthiness check
  // downstream without a word (peer, Low).
  if (!isPlainReportObject(parsed)) {
    return refuse(`runtime:doctor output parsed but is not a report object (exit ${failure})`);
  }
  // Two independent sources for the same fact; either alone is enough. The exit
  // code covers a caller that lost the report field, and the report field covers
  // a doctor whose ladder predates this constant.
  const recordFailed = exitCode === DOCTOR_EXIT.RECORD_FAILED
    || (parsed.doctor_artifact?.requested === true && parsed.doctor_artifact.written !== true);
  return { report: parsed, recordFailed, diagnostic: null };
}

function isPlainReportObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `effective` is the resolved effective selection (§6.2), never the raw manifest
// selection: a Codex hook plugin the operator declined must leave the attested set,
// or this non-declinable step asks for an attestation covering a plugin that will
// never be installed — permanently unsatisfiable.
function hookVerdictFor({ recordedAttestation, pluginSet, effective, probe }) {
  const codexHookPlugins = codexHookBearingPlugins(pluginSet, effective.byHost.codex);
  const applicable = codexHookPlugins.length > 0;
  return recomputeHookAttestation(recordedAttestation ?? null, {
    current: currentBoundVersions({ probe, selection: effective, runtimeVersion: RUNTIME_VERSION }),
    expectedPlugins: codexHookPlugins,
    probe,
    applicable,
  });
}

// Whether two effective selections are the same expectation. A decline changes what
// the registry derives — Stage-3 membership, the Codex-hook-bearing set and its
// `blocked_by` edges — so a verb that recorded one must re-derive and re-judge before
// it reduces, or it reports a completion computed against the selection the operator
// just narrowed. Compared structurally rather than by "did anything get declined",
// because a HOST-scoped decline narrows `byHost` while leaving `plugins` untouched.
function sameEffectiveSelection(a, b) {
  if (a.plugins.join(',') !== b.plugins.join(',')) return false;
  for (const host of ['claude', 'codex']) {
    if ((a.byHost[host] ?? []).join(',') !== (b.byHost[host] ?? []).join(',')) return false;
  }
  return true;
}

// §6.2 — the history row a narrowing writes. The run's account has to explain why a
// plugin stopped being expected; `choices[]` records the answer, this records the
// consequence.
function selectionNarrowedHistoryRow({ before, after, dropped, at }) {
  return {
    step_id: null,
    from: `${before.bundle}:${[...before.desired].sort().join('+') || 'nothing'}`,
    to: `${after.bundle}:${[...after.desired].sort().join('+') || 'nothing'}`,
    reason: `selection narrowed to the effective custom selection by operator decline (§6.2): ${dropped.join(', ')}`,
    at,
  };
}

/**
 * The report-side projection of the standing value decisions (§3.3).
 *
 * Every value is reconstructed from the fold's validated map rather than lifted
 * from the ledger's raw `answer` string, so the §3.2 disclosure invariant holds:
 * a grammar-clamped value crosses, unclamped operator text never does.
 */
function valueDecisionRows(standing) {
  const rows = [];
  for (const stepId of Object.keys(VALUE_STEPS)) {
    const entry = standing?.get(stepId) ?? null;
    if (!entry || entry.mode === 'none') continue;
    rows.push({
      step_id: stepId,
      mode: entry.mode,
      decisions: entry.mode === 'set'
        ? Object.fromEntries([...entry.decisions].sort(([a], [b]) => a.localeCompare(b)))
        : null,
      at: entry.at ?? null,
    });
  }
  return rows;
}

function buildManifestShape({ selection, probe, steps, choices, history, completion, planHash, seededFrom }) {
  return {
    schema: RUN_SCHEMA_VERSION,
    // run_id / started_at / updated_at / status are stamped by the storage
    // layer (createBootstrapRun); placeholders here keep the validator honest.
    selection,
    ...(seededFrom ? { seeded_from: seededFrom } : {}),
    choices,
    history,
    probe,
    plan_hash: planHash,
    steps,
    completion,
    boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
    limits: [
      'artifact-only (M1): writes land only under the machine-global ~/.agentic-plugins home (§10)',
      'render-and-confirm: every host-config change is a fragment plus an apply command; the operator applies, bootstrap re-probes (§1)',
      'no executor: plugin management is presented to runtime:settings --execute-plugin-management, never run here (§1.6)',
      'status/verify are R0: they re-probe and re-judge in memory, and write nothing (§3)',
    ],
  };
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

async function runPlan(ctx, opts) {
  const { pluginSet, validateRun, validateProfile } = await loadContext(ctx);

  // Concurrency (§10.2): a second plan while a run is open is rejected, naming
  // the open run's id. createBootstrapRun re-checks under the family lock; this
  // pre-check exists to fail fast with the same message shape.
  const scan = await scanBootstrapRuns({ homeDir: ctx.homeDir });
  if (scan.status === 'available') {
    const blocking = selectBlockingRuns(scan.runs);
    if (blocking.length > 0) {
      return {
        exitCode: EXIT.INVALID,
        report: {
          verb: 'plan',
          status: 'refused',
          reason: 'run-open',
          open_runs: blocking.map((r) => r.run_id),
          diagnostics: blocking.map((r) => `Run ${r.run_id} is not proven terminal; continue it (resume --latest-open) or close it (abandon ${r.run_id}) before a new plan.`),
        },
      };
    }
  }

  let seededSelection = null;
  let seededFrom = null;
  let seededProposals = null;
  const seededWarnings = [];
  if (opts.profile_file) {
    const seeded = await readProfileFile(ctx, opts.profile_file);
    seededSelection = seeded.profile.selection;
    seededFrom = { profile_id: seeded.profileId, profile_hash: seeded.hash };
    seededWarnings.push(...seeded.warnings);
    // §3 says "`plan --profile-file` is sugar for `plan` immediately followed by
    // `seed`", and only HALF of that was true: this path recorded the
    // `seeded_from` linkage and dropped every per-key proposal on the floor,
    // because `seedProposals` was called by the standalone `profile seed` verb
    // and nowhere else. The plan report had no `proposals` key at all, so a
    // profile carried to a new machine seeded its plugin SELECTION and none of
    // its configuration — which is most of what a machine profile is for.
    //
    // §4.5.4 is preserved exactly: these are DEFAULTS that pre-fill the
    // interview, never decisions. Nothing here writes a `choices[]` row; the
    // operator still answers, and `seedProposals` still does the safety grading
    // that refuses to propose an unsafe source posture as a default.
    const proposals = seedProposals({ profile: seeded.profile, validate: validateProfile });
    if (proposals?.ok === false) {
      return {
        exitCode: EXIT.INVALID,
        report: { verb: 'plan', status: 'refused', reason: 'profile-rejected', diagnostics: proposals.refused ?? ['profile failed seed validation'] },
      };
    }
    // A seeded value is a DEFAULT the operator confirms, and confirming it
    // produces a `set:` answer — so a profile value the value grammar refuses
    // (an all-kinds `notify_kinds`, say, which a 1.2 profile can carry because
    // the profile schema types it as a bare scalar) would be presented as a
    // sensible default and then rejected at the answers boundary. Marked here,
    // where both the proposal and the grammar are in scope; `seedProposals`
    // stays free of the bootstrap-only grammar it has no business importing.
    seededWarnings.push(...markUnanswerableProposals(proposals));
    seededProposals = sanitizeProposals(proposals);
  }

  // `selection` is rebindable: an answers file carrying a plugin decline narrows it to
  // the §6.2 effective custom selection before anything is persisted.
  let { selection, softWarnings } = resolveSelection({ opts, pluginSet, seededSelection });
  const { raw, probe } = await probeNow(ctx);
  const readers = await readUserGlobalReaders(ctx);

  // Answers are read BEFORE the expected-step derivation so a plan-time egress
  // opt-in (a decline against proof.egress-provider-ack, say) can make the
  // step expected at all — applyAnswers rejects answers about unexpected steps.
  const answers = opts.answers ? await readAnswersFile(opts.answers) : [];
  const egressProofRequested = answers.some((a) => a.step_id === stepIds.proofEgressProviderAck());

  // §3.3 — the standing decisions this judge sees. `plan` starts a NEW run, so
  // the only ledger is this verb's own answers; it is empty on the first pass
  // and re-folded after applyAnswers below (see the re-judge there for why a
  // single pass cannot be correct).
  let standingNow = new Map();
  const deriveAndJudge = (effectiveSel, previousSteps = null) => {
    const derived = deriveExpectedSteps({ pluginSet, selection: effectiveSel, egressProofRequested });
    expectedNow = derived;
    const graph = validateStepGraph(derived);
    if (!graph.ok) throw new Error(`step registry produced an invalid graph (runtime bug): ${graph.errors.join('; ')}`);
    const verdict = hookVerdictFor({ recordedAttestation: null, pluginSet, effective: effectiveSel, probe });
    return judgeSteps({
      expected: derived,
      probe,
      raw,
      pluginSet,
      hookVerdict: verdict,
      standing: standingNow,
      ...(previousSteps ? { previousById: priorJudgeMapOf(previousSteps) } : {}),
      readers,
      now: ctx.now,
    });
  };

  let expectedNow = null;
  let effective = effectiveSelection({ pluginSet, selection, steps: [] });
  let steps = deriveAndJudge(effective);

  const { choices, history } = applyAnswers({ steps, answers, now: ctx.now, selection, pluginSet, verb: 'plan', expected: expectedNow, priorChoices: [] });
  // Collected before `warnings` exists (it is composed below from several
  // sources), then folded into it — a push into `warnings` here is a TDZ error.
  const foldWarningsNow = [];

  // §3.3 — RE-JUDGE against the decisions this verb just recorded. Judgement
  // runs BEFORE applyAnswers (it has to: the answers grammar reads the judged
  // applicability), so a first pass necessarily judges a value step against the
  // PREVIOUS standing decision — on `plan`, against none at all. Persisting that
  // would record a status the observation never matched. This is the same
  // re-judge shape the file already uses after selection narrowing and after a
  // hook-attestation import, not a new mechanism.
  if (choices.some((row) => isValueStep(row.step_id) && classifyAnswer(row.answer).kind === 'set')) {
    const foldedNow = foldStandingDecisions(choices, { documentMinor: READER_RUN_SCHEMA.minor });
    standingNow = foldedNow.standing;
    foldWarningsNow.push(...foldedNow.malformed, ...foldedNow.preDating, ...dualKindWarningsFor(standingNow));
    steps = deriveAndJudge(effective, steps);
  }

  const warnings = [
    ...softWarnings,
    ...seededWarnings,
    ...foldWarningsNow,
    // PLAN is where the opt-in decision is still cheap: the answers file is
    // already in the operator's hands and no proof has run yet.
    ...optInProofWarnings({ expected: expectedNow }),
  ];

  // §6.2 — a plugin decline creates a new effective `custom` selection. The retained
  // set is PERSISTED (below, through buildManifestShape) rather than recomputed by
  // each consumer, and the expectation is re-derived here so this run never reduces
  // against the selection the operator just narrowed.
  const narrowed = narrowSelectionByDeclines({ pluginSet, selection, steps });
  if (narrowed.changed) {
    history.push(selectionNarrowedHistoryRow({ before: selection, after: narrowed.selection, dropped: narrowed.dropped, at: new Date(ctx.now).toISOString() }));
    selection = narrowed.selection;
  }
  for (const refused of narrowed.refusedButRetained) warnings.push(refused.reason);
  const narrowedEffective = effectiveSelection({ pluginSet, selection, steps });
  if (!sameEffectiveSelection(effective, narrowedEffective)) {
    effective = narrowedEffective;
    steps = deriveAndJudge(effective, steps);
  }

  const stage0 = buildStage0(probe, raw);
  const candidates = buildPluginActionCandidates({ effective, pluginSet, probe });
  const planHash = candidates.length > 0
    ? await fetchSettingsPlanHash({ subprocessRunner: ctx.subprocessRunner, cwd: ctx.cwd, env: scrubbedControlPlaneEnv(ctx.env) })
    : { hash: null, status: 'not-needed', reason: 'no plugin-management actions are needed' };

  const completion = reduceCompletion({ pluginSet, selection: effective, steps, choices, proofs: [], hookAttestation: null, probe, runtimeVersion: RUNTIME_VERSION, currentActivationFingerprint: currentActivationFingerprintOf(readers) });
  const manifest = buildManifestShape({ selection, probe, steps, choices, history, completion, planHash: planHash.hash, seededFrom });

  const created = await createBootstrapRun({
    homeDir: ctx.homeDir,
    repoRoot: ctx.cwd,
    now: ctx.now,
    manifest: { ...manifest, run_id: undefined, started_at: undefined, updated_at: undefined, status: undefined },
    validate: validateRun,
  });
  if (!created.created) {
    return {
      exitCode: created.reason === 'run-open' ? EXIT.INVALID : created.reason === 'invalid-manifest' ? EXIT.INVALID : EXIT.UNEXPECTED,
      report: { verb: 'plan', status: 'refused', reason: created.reason, diagnostics: created.diagnostics },
    };
  }

  // Fragments are rendered AFTER the run exists (they live inside it); the
  // manifest is then updated with the pointers under the family lock.
  await composeFragments({ homeDir: ctx.homeDir, cwd: ctx.cwd, env: ctx.env, runId: created.run_id, now: ctx.now, steps, warnings, readersForFragments: readers, standingForFragments: standingNow });
  const updated = await updateBootstrapRun({
    homeDir: ctx.homeDir,
    repoRoot: ctx.cwd,
    runId: created.run_id,
    now: ctx.now,
    validate: validateRun,
    mutate: (m) => ({ ...m, steps }),
  });
  if (!updated.updated) warnings.push(`fragment pointers could not be persisted into the manifest: ${updated.diagnostics.join('; ')}`);
  // A SUCCESSFUL update can still carry diagnostics — the family lock merges its
  // own into the result, and a release that could not put back a lock it
  // displaced reports there. Reading them only on the failure branch made that
  // reporting inert (peer round-3 MAJOR): the write landed, so nobody saw that a
  // lock name may have been left free.
  else if (updated.diagnostics?.length) warnings.push(...updated.diagnostics);

  const report = {
    verb: 'plan',
    run_id: created.run_id,
    run_pointer: created.pointer,
    selection,
    completion,
    steps,
    stage0,
    plugin_management: presentPluginManagement({ candidates, planHash }),
    value_decisions: valueDecisionRows(standingNow),
    ...(seededFrom ? { seeded_from: seededFrom } : {}),
    ...(seededProposals ? { proposals: seededProposals } : {}),
    probe,
    warnings,
    diagnostics: created.diagnostics,
  };
  return { exitCode: EXIT_BY_STATE[completion.state] ?? EXIT.UNEXPECTED, report };
}

/**
 * `converge` — whether the effective selection is re-derived from the FRESH rows
 * (see the convergence block below). Every verb that speaks about the machine as
 * it is NOW converges. `attest` alone does not (owner decision, 2026-08-02): it
 * is the post-terminal receipt door, its subject is a send that already happened,
 * and the gate it protects asks whether a RECORDED ack may be testified about.
 * §7's drift clause names *bound versions*; refusing testimony because the
 * operator installed an unrelated plugin afterwards is a selection-drift refusal
 * the contract never specified, and it is unrecoverable — resume refuses a
 * terminal run, so the owner who really received the receipt could never record
 * it. So attest judges the run as the run was reduced.
 *
 * The cost is stated rather than hidden: attest's recomputed verdict can then
 * differ from `status`'s for the same run. That is why `selectionRestored` is
 * computed even when `converge` is false — the caller must SAY the selection has
 * lapsed rather than let two verbs disagree in silence.
 */
async function reprobeAgainstRun(ctx, manifest, pluginSet, { egressProofRequested = false, converge = true } = {}) {
  // ADR-0048 §3 — re-judgement consumes the RECORDED evidence (proof/ files,
  // which keep their per-direction results / provider_ack), never the
  // manifest's reduced completion.proofs. The reduced shape has no directions
  // by design, so reading it back demoted every once-passed proof to `absent`
  // on the second resume/verify — the exact false-demotion this read-back
  // exists to end. Fail-closed: unreadable/invalid evidence stops the verb
  // with the file named, rather than reducing over evidence nobody can trust.
  const proofRead = await readBootstrapProofRecords({ homeDir: ctx.homeDir, runId: manifest.run_id });
  if (!proofRead.ok) return { proofReadFailure: proofRead.errors };
  const recordedProofs = proofRead.records.filter((r) => PROOF_KINDS.includes(r.kind)).map((r) => r.record);
  const recordedHookAttestation = proofRead.records.find((r) => r.kind === 'hook-attestation')?.record ?? null;

  const { raw, probe } = await probeNow(ctx);
  const readers = await readUserGlobalReaders(ctx);
  const selection = manifest.selection;
  // §6.2 — the EFFECTIVE selection, derived on every verb rather than read from the
  // manifest alone. Two runs need that. A legacy run planned before the narrowing
  // existed carries its declines only as `declined` step rows, and `status`/`verify`
  // are R0 — they cannot persist a correction, but they must not report a completion
  // computed against plugins the operator refused either. Deriving here means every
  // verb agrees, and the next `resume` writes the narrowed selection through.
  // REBINDABLE: the judge below re-observes the very rows this derives from, so
  // a decline a satisfying observation clears converges into it further down.
  let effective = effectiveSelection({ pluginSet, selection, steps: manifest.steps ?? [] });
  // The egress proof opt-in (D0.2) persists once made: a recorded decline, an
  // answer in the run's ledger, or recorded delivery evidence keeps it expected
  // across every later verb — the caller ORs in this verb's fresh answers. The
  // run-side legs go through the reducer's shared predicate rather than id
  // matches written out again here: a bare `some(s => s.id === …)` was true on
  // every run ever planned (the registry enumerates the step even when it does
  // not apply), which is the same defect the reducer carried, in a second copy.
  // One predicate, so the two readers cannot drift.
  const egressOptIn = egressProofRequested
    || egressProofOptedIn({ steps: manifest.steps, choices: manifest.choices, proofs: recordedProofs });
  const storedFragmentApplied = permissionFragmentAppliedFrom(manifest.steps);
  let expected = deriveExpectedSteps({
    pluginSet,
    selection: effective,
    permissionFragmentApplied: storedFragmentApplied,
    egressProofRequested: egressOptIn,
  });
  // Rebindable for the same reason: it is scoped to `effective`.
  let hookVerdict = hookVerdictFor({ recordedAttestation: recordedHookAttestation, pluginSet, effective, probe });

  // §7 — recorded step state is invalidated (reset to pending, stamped) when
  // runtime / either host CLI / any selected plugin version moved since the
  // recorded probe. Computed here for every verb; PERSISTED only by resume.
  const current = currentBoundVersions({ probe, selection: effective, runtimeVersion: RUNTIME_VERSION });
  const invalidation = invalidateStaleSteps({
    steps: manifest.steps ?? [],
    probe: manifest.probe ?? null,
    current,
    selection: effective,
    at: new Date(ctx.now).toISOString(),
  });
  // A pre-split run carried the Codex notification fragment on
  // notify.configured (the local-policy step); post-split it belongs to
  // notify.codex.configured, and carrying the stale pointer forward would keep
  // presenting the Codex merge command on the wrong step — and could mark that
  // unrelated fragment applied when the LOCAL policy satisfies (Codex review
  // MINOR). Strip the legacy metadata; composeFragments re-renders it onto the
  // right step on this same resume.
  const priorForJudge = priorJudgeMapOf(invalidation.steps);

  // §3.3 — the PERSISTED standing decisions. Every verb that re-probes reads the
  // ledger the run already carries; `resume` layers its own incoming answers on
  // top afterwards (see its re-judge). Threading the same fold through every
  // judgement site is what stops `status` and `resume` disagreeing about which
  // value the operator stands behind.
  const documentMinor = parseRunSchemaMinor(manifest.schema)?.minor ?? null;
  const folded = foldStandingDecisions(manifest.choices, { documentMinor });
  const standing = folded.standing;
  // §3.3 — a value row this runtime declined to honour is REPORTED, not
  // swallowed. The fold returns them and every caller used to drop them on the
  // floor, so a step whose recorded answer stopped parsing (a renamed key, a
  // hand-edited manifest) reported "No decision is recorded" while `choices[]`
  // visibly held a row for it — the operator was told to answer a step they had
  // answered, with no explanation (code review, MEDIUM).
  const foldWarnings = [...folded.malformed, ...folded.preDating, ...dualKindWarningsFor(standing)];

  let steps = judgeSteps({ expected, probe, raw, pluginSet, readers, hookVerdict, previousById: priorForJudge, standing, now: ctx.now });

  // SECOND PASS on the permission fragment, for the same reason the selection
  // narrowing re-derives further down: a judgement INPUT changed during the
  // judgement. `fragment_applied` is PROMOTED here — it marks a fragment this
  // run rendered and a later probe observed the operator applying — while the
  // expectation above could only read the value STORED before that observation.
  // So on the very resume that first sees the application, `proof.permission`
  // derived `applicable: false` over a run that had just earned it. That cost an
  // extra cycle silently before; once applicability became a REFUSAL at the
  // answer boundary it turned an ordinary flow — plan, apply the fragments,
  // resume with `execute proof.permission` — into exit 40 (cross-host
  // Refine-verify, High; reproduced). Re-derive from what was observed.
  //
  // The SELECTION is the second such input, and it is stale for exactly the same
  // reason: `effective` above was derived from the STORED rows, and this judge
  // re-observes them. §6.2 lets a satisfying observation clear a `declined` row,
  // a host-scoped refusal lives only in that row, and the effective selection
  // reads nothing else — so a plugin refused on a host and later installed there
  // makes every verb report rows that say `satisfied` beside a selection that
  // still excludes it. Measured on `status`/`verify`, which are the worse half
  // because they cannot persist a correction and a terminal run cannot be
  // resumed: a completed run whose Codex-refused, Codex-hook-bearing plugin was
  // afterwards installed reports both its rows `satisfied`, leaves
  // `hooks.codex.attested` `not-applicable`, and returns `complete` at exit 0 —
  // for good (cross-host Refine-verify round 2, MAJOR; reproduced). Converging
  // here is what makes §7's "a host-scoped exclusion is re-derived by every
  // verb" true rather than an aspiration, and resume then converges a SECOND
  // time after its executor, because the machine can move again in between.
  //
  // Same bound as that later pass, for the same reason: judgeSteps only restores
  // declines from `previous` and never invents one, and the derivation is asked
  // about the already-retained set, so the plugin set cannot move and `byHost`
  // only widens. Two derivations reach the fixpoint.
  const judgedFragmentApplied = permissionFragmentAppliedFrom(steps);
  const convergedEffective = effectiveSelection({ pluginSet, selection: { desired: effective.plugins }, steps });
  const selectionMoved = !sameEffectiveSelection(effective, convergedEffective);
  // The convergence is REPORTED, not silent (cross-host Review peer, MINOR): a
  // refusal that stopped following from the run's own rows is something the
  // operator decided and must be told has lapsed — otherwise the only visible
  // effect is a completion that quietly stopped being `complete`. The rows are
  // returned rather than pushed, because this helper has no warnings channel of
  // its own and each verb owns its own list.
  const selectionRestored = [];
  if (selectionMoved) {
    for (const host of ['claude', 'codex']) {
      const restored = (convergedEffective.byHost[host] ?? []).filter((name) => !(effective.byHost[host] ?? []).includes(name));
      if (restored.length > 0) selectionRestored.push({ host, plugins: restored });
    }
  }
  const applySelection = converge && selectionMoved;
  if (applySelection || ['claude', 'codex'].some((h) => judgedFragmentApplied[h] !== storedFragmentApplied[h])) {
    if (applySelection) {
      effective = convergedEffective;
      hookVerdict = hookVerdictFor({ recordedAttestation: recordedHookAttestation, pluginSet, effective, probe });
    }
    expected = deriveExpectedSteps({
      pluginSet,
      selection: effective,
      permissionFragmentApplied: judgedFragmentApplied,
      egressProofRequested: egressOptIn,
    });
    const graph = validateStepGraph(expected);
    if (!graph.ok) throw new Error(`step registry produced an invalid graph (runtime bug): ${graph.errors.join('; ')}`);
    steps = judgeSteps({ expected, probe, raw, pluginSet, readers, hookVerdict, previousById: priorForJudge, standing, now: ctx.now });
  }
  const receiptRow = proofRead.records.find((r) => r.kind === 'egress-receipt-attestation') ?? null;
  const ackRow = proofRead.records.find((r) => r.kind === 'egress-provider-ack') ?? null;
  const completion = reduceCompletion({
    pluginSet,
    selection: effective,
    steps,
    choices: manifest.choices,
    proofs: recordedProofs,
    hookAttestation: recordedHookAttestation,
    probe,
    runtimeVersion: RUNTIME_VERSION,
    currentActivationFingerprint: currentActivationFingerprintOf(readers),
    receiptEvidence: receiptRow ? { record: receiptRow.record, providerAckSha256: ackRow?.sha256 ?? null } : null,
  });
  // `expected` rides out so a caller that changes a judgement INPUT after this
  // pass (resume importing a hook attestation) can re-run judgeSteps instead of
  // leaving the step judged against evidence the same verb has since superseded.
  // The previous-state map is deliberately NOT exported: that caller must build
  // it from ITS OWN current steps, since applyAnswers has mutated them since.
  return { raw, probe, readers, steps, completion, selection, effective, standing, foldWarnings, invalidation, proofRecords: proofRead.records, recordedHookAttestation, expected, egressOptIn, selectionRestored };
}

/**
 * ADR-0048 §1 — a TERMINAL run under an older schema minor is immutable
 * historical evidence: status/verify re-probe nothing and re-certify nothing
 * (its proof files are not even read — a legacy complete with a corrupt proof
 * file is still the historical record it was). The report carries
 * machine-readable `historical` + `not_recertified` markers and exits
 * LEGACY_HISTORICAL, because exit 0 would claim a current completion nobody
 * re-proved. Returns null when the run is not a legacy terminal one.
 *
 * D1 (ratified 2026-08-02) — what it PRESENTS is a projection, not a replay.
 * The record on disk is still immutable and still byte-identical after this
 * call; what changed is that its two maxLength-only strings (`reasons[]` and
 * `artifact_pointer`) no longer travel to stdout. `legacy_completion_summary`
 * is deliberately not named `completion`: a consumer must not be able to mistake
 * a disclosable summary for the stored object.
 */
function legacyTerminalReport(verb, picked) {
  const doc = parseRunSchemaMinor(picked.manifest.schema);
  if (!doc || doc.minor >= READER_RUN_SCHEMA.minor) return null;
  if (!BOOTSTRAP_TERMINAL_RUN_STATUSES.includes(picked.manifest.status)) return null;
  // The pointer is DERIVED from the run id (which `validateBootstrapRunId`
  // clamps) and the fixed family path — never the stored `artifact_pointer`
  // string, which is free content in the same record this projection exists to
  // bound.
  const artifactPointer = `~/.agentic-plugins/runs/bootstrap/${picked.run.run_id}/run.json`;
  return {
    exitCode: EXIT.LEGACY_HISTORICAL,
    report: {
      verb,
      run_id: picked.run.run_id,
      run_status: picked.manifest.status,
      // `legacy_schema` is the document's own schema string, and it reached
      // here only because parseRunSchemaMinor matched it against this family's
      // grammar — same clamp the version gate applies.
      legacy_schema: picked.manifest.schema,
      historical: true,
      not_recertified: true,
      selection: picked.manifest.selection,
      legacy_completion_summary: projectLegacyCompletion(picked.manifest.completion ?? null, { artifactPointer }),
      diagnostics: [
        `Run ${picked.run.run_id} is terminal under legacy schema ${picked.manifest.schema} — presented as immutable historical evidence; nothing was re-probed or re-certified against the ${RUN_SCHEMA_VERSION} registry (ADR-0048 §1). Start a fresh \`runtime:bootstrap plan\` for current evidence.`,
        `The stored completion is summarized, not replayed: free-text fields (proof reasons, the stored artifact pointer) are withheld and reported as counts, because a historical record is operator-editable and this report travels further than the 0600 artifact does. Read ${artifactPointer} directly for the full record.`,
      ],
    },
  };
}

/**
 * The R0 half of §6.2. `status` and `verify` re-judge against the EFFECTIVE selection
 * but write nothing, so a run recorded before the narrowing existed reports a stored
 * `selection` that its own completion was not computed against. Rather than silently
 * present one and judge the other, the divergence is named: the stored selection stays
 * verbatim (it is the record), the retained set rides alongside it, and the warning
 * says which verb closes the gap. Returns null when the two agree — the ordinary case,
 * which must stay byte-identical to the pre-§6.2 report.
 */
function effectiveSelectionDivergence({ pluginSet, selection, effective }) {
  const planned = [...new Set(selection?.desired ?? [])].sort();
  const droppedPlugins = planned.filter((name) => !effective.plugins.includes(name));
  const droppedHostRows = [];
  for (const host of ['claude', 'codex']) {
    for (const name of effective.plugins) {
      // Only a host the plugin actually TARGETS can be a refusal. Without this the
      // per-host retained set would read every Claude-only plugin as declined on
      // Codex — a warning about a decline nobody made.
      if (!(pluginSet.plugins?.[name]?.hosts ?? []).includes(host)) continue;
      if (!effective.byHost[host].includes(name)) droppedHostRows.push(`${name}:${host}`);
    }
  }
  if (droppedPlugins.length === 0 && droppedHostRows.length === 0) return null;
  // The two kinds of refusal have DIFFERENT remedies, and collapsing them promised a
  // repair that cannot happen (Refine-verify peer, High/Medium): a whole-plugin
  // decline is written into the selection by the next resume, while a host-scoped one
  // has no seat to be written into — `desired` is a flat name list — so telling the
  // operator to resume would repeat forever against a state that is already correct.
  const parts = [];
  if (droppedPlugins.length > 0) {
    parts.push(`${droppedPlugins.join(', ')} declined outright, which the stored selection does not yet record — \`runtime:bootstrap resume\` writes the narrowing through; status and verify are read-only (§3) and cannot`);
  }
  if (droppedHostRows.length > 0) {
    parts.push(`${droppedHostRows.join(', ')} declined on that host only, which the selection seat cannot express (\`desired\` is a flat name list) — the refusal lives in the declined step row, and no resume moves it`);
  }
  return {
    effective_selection: { plugins: effective.plugins, by_host: effective.byHost },
    warning: `this run is judged against the effective selection (§6.2): ${parts.join('; ')}.`,
  };
}

async function runStatus(ctx, opts) {
  const { pluginSet, validateRun } = await loadContext(ctx);
  const picked = await selectRun({ homeDir: ctx.homeDir, opts, defaultSelector: 'latest', validateRun });
  if (picked.error) {
    return { exitCode: picked.exitCode, report: { verb: 'status', status: 'no-active-run', diagnostics: [picked.error === 'no-active-run' ? 'No bootstrap run exists; status never synthesizes one (§3). Start with `runtime:bootstrap plan`.' : picked.error] } };
  }
  const legacy = legacyTerminalReport('status', picked);
  if (legacy) return legacy;
  // R0 — re-probe, re-judge IN MEMORY, report. Nothing below writes (test #33).
  const reprobe = await reprobeAgainstRun(ctx, picked.manifest, pluginSet);
  if (reprobe.proofReadFailure) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'status', status: 'evidence-unreadable', diagnostics: reprobe.proofReadFailure } };
  }
  const { probe, steps, completion } = reprobe;
  const divergence = effectiveSelectionDivergence({ pluginSet, selection: picked.manifest.selection, effective: reprobe.effective });
  const report = {
    verb: 'status',
    run_id: picked.run.run_id,
    run_status: picked.manifest.status,
    selection: picked.manifest.selection,
    ...(divergence ? { effective_selection: divergence.effective_selection } : {}),
    completion,
    steps,
    value_decisions: valueDecisionRows(reprobe.standing),
    probe,
    warnings: [...(picked.warnings ?? []), ...(reprobe.foldWarnings ?? []), ...selectionRestoredWarnings(reprobe.selectionRestored, { window: 'as of this re-probe', consequence: 'The selection was re-derived and the affected steps re-judged.' }), ...(divergence ? [divergence.warning] : [])],
    diagnostics: [],
  };
  return { exitCode: EXIT_BY_STATE[completion.state] ?? EXIT.UNEXPECTED, report };
}

async function runVerify(ctx, opts) {
  const { pluginSet, validateRun } = await loadContext(ctx);
  const picked = await selectRun({ homeDir: ctx.homeDir, opts, defaultSelector: 'latest', validateRun });
  if (picked.error) {
    return { exitCode: picked.exitCode, report: { verb: 'verify', status: 'no-active-run', diagnostics: [picked.error === 'no-active-run' ? 'No bootstrap run exists; verify never synthesizes one (§3).' : picked.error] } };
  }
  const legacy = legacyTerminalReport('verify', picked);
  if (legacy) return legacy;
  // §3 errata — verify does not RUN proofs; it re-judges the RECORDED ones
  // against the current probe's bound versions and reports. An absent required
  // proof is reported `absent` (the reducer caps at configured-not-verified →
  // exit 10); it is never manufactured here (test #33's negative half).
  const reprobe = await reprobeAgainstRun(ctx, picked.manifest, pluginSet);
  if (reprobe.proofReadFailure) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'verify', status: 'evidence-unreadable', diagnostics: reprobe.proofReadFailure } };
  }
  const { probe, steps, completion } = reprobe;
  const divergence = effectiveSelectionDivergence({ pluginSet, selection: picked.manifest.selection, effective: reprobe.effective });
  const report = {
    verb: 'verify',
    run_id: picked.run.run_id,
    run_status: picked.manifest.status,
    selection: picked.manifest.selection,
    ...(divergence ? { effective_selection: divergence.effective_selection } : {}),
    completion,
    proofs: completion.proofs,
    hook_attestation: completion.hook_attestation,
    steps,
    value_decisions: valueDecisionRows(reprobe.standing),
    probe,
    warnings: [...(picked.warnings ?? []), ...(reprobe.foldWarnings ?? []), ...selectionRestoredWarnings(reprobe.selectionRestored, { window: 'as of this re-probe', consequence: 'The selection was re-derived and the affected steps re-judged.' }), ...(divergence ? [divergence.warning] : [])],
    diagnostics: [],
  };
  return { exitCode: EXIT_BY_STATE[completion.state] ?? EXIT.UNEXPECTED, report };
}

const PROOF_EXECUTE_FLAGS = Object.freeze({
  'deep-peer-smoke': ['--deep-peer-smoke', '--execute-deep-peer-smoke'],
  'workflow-continuation': ['--workflow-continuation-proof', '--execute-workflow-continuation-proof'],
  permission: ['--permission-proof', '--execute-permission-proof'],
  // ADR-0048 §3 — the one real-network executor. The flag pair is only two of
  // the three consents: doctor additionally refuses the send unless
  // AGENTIC_EGRESS_REAL_SMOKE=1 is present in the (deliberately UNSCRUBBED,
  // §4 documented exception) environment this subprocess inherits.
  'egress-provider-ack': ['--egress-ack-proof', '--execute-egress-ack-proof'],
});

const DOCTOR_SECTION_BY_KIND = Object.freeze({
  'deep-peer-smoke': 'deep_peer_smoke',
  'workflow-continuation': 'workflow_continuation_proof',
  permission: 'permission_proof',
  'egress-provider-ack': 'egress_ack_proof',
});

function mapDoctorDirectionStatus(direction) {
  if (!direction || direction.execution === 'not_executed') return 'absent';
  // `passed` requires POSITIVE execution evidence (Codex review BLOCKER): a
  // direction whose `execution` is missing or unknown must not read as a pass
  // just because a status string says so — absent-of-evidence is not evidence.
  if (direction.execution !== 'executed') return 'blocked';
  if (direction.status === 'passed') return 'passed';
  if (direction.status === 'failed') return 'failed';
  return 'blocked';
}

/**
 * §8.2 — resume, and only resume, produces Stage-8 evidence: it invokes
 * `runtime:doctor --record` with the relevant `--execute-*` flag and an explicit
 * repo-root, then copies the proof's METADATA ONLY (per-direction results,
 * pointers, hashes, bound versions) into the run's proof/ directory. Raw peer
 * output is never copied and never printed.
 */
async function executeProofViaDoctor(ctx, { kind, probe, effective }) {
  const doctorPath = join(SCRIPT_DIR, 'doctor.mjs');
  const args = ['--repo-root', ctx.cwd, '--format', 'json', '--record', ...PROOF_EXECUTE_FLAGS[kind]];
  const result = await ctx.subprocessRunner(doctorPath, args, { cwd: ctx.cwd, env: ctx.env, timeoutMs: 600_000 });
  const read = readDoctorSubprocessReport(result);
  if (!read.report) {
    return { ok: false, diagnostic: `runtime:doctor --record for ${kind} failed: ${read.diagnostic}`, record: null };
  }
  if (read.recordFailed) {
    // The proof may well have RUN — but §8.2 imports its metadata alongside the
    // artifact's exact-byte hash, and there is no artifact. Storing the record
    // anyway would persist an `artifact_hash` of null against a pointer nothing
    // can verify, which is the claim ADR-0048 §3 exists to refuse.
    // Egress is the ONE side-effecting proof, and a record failure says nothing
    // about whether the send landed: the provider call happens long before the
    // artifact is written. Advise reconcile-then-retry there rather than letting
    // the operator read "not imported" as "not sent" and re-run into a duplicate
    // message on their phone.
    const egressCaveat = kind === 'egress-provider-ack'
      ? ' — the send itself may ALREADY have succeeded, so check the phone and the intent WAL before re-running this proof'
      : '';
    return {
      ok: false,
      diagnostic: `runtime:doctor ran the ${kind} proof but could not persist its artifact at the ${read.report.doctor_artifact?.failed_phase ?? 'unknown'} phase (${read.report.doctor_artifact?.error ?? 'write failed'}); the proof cannot be imported without a hash-linkable artifact${egressCaveat}`,
      record: null,
      doctorReport: read.report,
    };
  }
  const report = read.report;
  const section = report?.[DOCTOR_SECTION_BY_KIND[kind]];
  const ranAt = new Date(ctx.now).toISOString();
  // The proof binds the RETAINED set (§6.2): a freshly executed proof must bind
  // exactly what `requiredBoundPlugins` will demand of it, or it re-judges stale the
  // moment it is written.
  const bound = currentBoundVersions({ probe, selection: effective, runtimeVersion: RUNTIME_VERSION });
  // ALL kinds link the doctor artifact by its exact-byte hash (ADR-0048 §3):
  // doctor --record returns artifact_sha256 computed from the bytes it renamed
  // into place, so the proof record's artifact_hash is verifiable against the
  // pointer instead of the null the pre-executor shape stored.
  const artifactHash = typeof report?.doctor_artifact?.artifact_sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(report.doctor_artifact.artifact_sha256)
    ? report.doctor_artifact.artifact_sha256
    : null;
  let evidence;
  if (kind === 'egress-provider-ack') {
    // Acked-consistency matrix (Plan-verify peer): before the metadata is
    // imported, the section must be INTERNALLY consistent —
    //   - an unexecuted section imports nothing (the blockers are the
    //     diagnostic; the kind stays absent and retryable);
    //   - every EXECUTED attempt must carry provider_ack (a failed attempt is
    //     evidence too; executed-without-ack is a doctor contract breach);
    //   - `passed` requires result=acked AND mirror_correlated AND a linkable
    //     artifact hash — a pass missing any leg is a claim the evidence does
    //     not back;
    //   - result=acked AND mirror_correlated under a non-passed status is the
    //     inverse contradiction. result=acked WITHOUT the mirror is a
    //     legitimate failed proof (the provider fact stands; the attempt is
    //     unverifiable) — provider_ack records the provider fact only, per
    //     the schema's providerAck $def.
    // Any mismatch refuses the import (fail-closed) rather than persisting a
    // record the reducer would have to argue with.
    if (!section?.executed) {
      const blockers = (section?.blockers ?? []).join('; ');
      return { ok: false, diagnostic: `runtime:doctor did not execute the egress ack proof (status=${section?.status ?? 'missing'})${blockers ? `: ${blockers}` : ''}`, record: null, doctorReport: report };
    }
    if (!section.provider_ack || typeof section.provider_ack !== 'object') {
      return { ok: false, diagnostic: 'the executed egress ack proof carries no provider_ack — an executed attempt without its evidence member cannot be imported', record: null, doctorReport: report };
    }
    if (section.status === 'passed' && (section.provider_ack.result !== 'acked' || section.mirror_correlated !== true || artifactHash === null)) {
      return { ok: false, diagnostic: `the egress ack proof is internally inconsistent: status=passed but result=${section.provider_ack.result}, mirror_correlated=${section.mirror_correlated}, artifact_hash=${artifactHash === null ? 'missing' : 'present'}`, record: null, doctorReport: report };
    }
    if (section.provider_ack.result === 'acked' && section.mirror_correlated === true && section.status !== 'passed') {
      return { ok: false, diagnostic: `the egress ack proof is internally inconsistent: result=acked with a correlated mirror but status=${section.status}`, record: null, doctorReport: report };
    }
    evidence = {
      status: section.status === 'passed' ? 'passed' : 'failed',
      provider_ack: {
        result: section.provider_ack.result,
        attempt_hash: section.provider_ack.attempt_hash,
        activation_fingerprint: section.provider_ack.activation_fingerprint,
        ran_at: section.provider_ack.ran_at,
      },
      // The independent mirror verdict is DURABLE evidence (schema 1.2
      // sibling seat): the reducer recomputes the aggregate from the
      // evidence members, never from stored status, so dropping the mirror
      // here would let an acked-but-unverifiable attempt re-evaluate to
      // passed on the next read (Refine-verify peer, round 2).
      mirror_correlated: section.mirror_correlated === true,
    };
  } else {
    evidence = {
      status: 'passed', // provenance only — the reducer recomputes from directions
      directions: {
        'claude->codex': { status: mapDoctorDirectionStatus(section?.directions?.claude_to_codex), ran_at: ranAt },
        'codex->claude': { status: mapDoctorDirectionStatus(section?.directions?.codex_to_claude), ran_at: ranAt },
      },
    };
  }
  const imported = importProofMetadata({
    kind,
    ...evidence,
    artifact_pointer: report?.doctor_artifact?.artifact_pointer ?? null,
    artifact_hash: artifactHash,
    bound_versions: bound,
    ran_at: ranAt,
  });
  if (!imported.ok) return { ok: false, diagnostic: `proof metadata for ${kind} did not import: ${imported.errors.join('; ')}`, record: null };
  return { ok: true, diagnostic: null, record: imported.record, doctorReport: report };
}

/**
 * D0.1 — assemble and persist the owner receipt attestation. Shared by the
 * `attest` verb (terminal runs) and resume's `attest-receipt` answer (open
 * runs with a pre-existing ack). The preconditions are evidence-side:
 * a recorded egress-provider-ack that STILL re-judges `passed`, whose stored
 * bytes the testimony links by hash. No free text, no device identifier — the
 * record carries exactly the two hashes and a time.
 */
async function recordReceiptAttestation(ctx, { runId, proofRecords, ackEvaluated }) {
  const ackRow = (proofRecords ?? []).find((r) => r.kind === 'egress-provider-ack') ?? null;
  if (!ackRow) {
    return { ok: false, diagnostic: 'no egress-provider-ack proof is recorded for this run — receipt testimony needs a pre-existing acked attempt to be about', proof: null };
  }
  if (ackEvaluated?.status !== 'passed') {
    return { ok: false, diagnostic: `the recorded egress-provider-ack re-judges ${ackEvaluated?.status ?? 'absent'} — only a currently-passing ack can be attested (${(ackEvaluated?.reasons ?? []).join('; ') || 'no reasons'})`, proof: null };
  }
  // Idempotent on identical testimony (Codex review MAJOR): a repeated attest
  // for the SAME attempt over the SAME stored ack bytes re-reports the existing
  // record instead of rewriting it (a fresh attested_at over unchanged links
  // adds no information and destroys the original timestamp). A DIFFERENT
  // attempt/hash writes through: the earlier testimony was about superseded
  // evidence, and the newest claim about the current ack is the standing one.
  const existingReceipt = (proofRecords ?? []).find((r) => r.kind === 'egress-receipt-attestation') ?? null;
  if (existingReceipt
    && existingReceipt.record.attempt_hash === ackRow.record.provider_ack.attempt_hash
    && existingReceipt.record.provider_proof_artifact_hash === ackRow.sha256) {
    return { ok: true, diagnostic: null, proof: { kind: 'egress-receipt-attestation', pointer: existingReceipt.pointer, sha256: existingReceipt.sha256, bytes: existingReceipt.bytes }, idempotent: true };
  }
  const record = {
    surface: 'owner-phone',
    attested_at: new Date(ctx.now).toISOString(),
    attempt_hash: ackRow.record.provider_ack.attempt_hash,
    provider_proof_artifact_hash: ackRow.sha256,
  };
  const persisted = await writeBootstrapProof({ homeDir: ctx.homeDir, repoRoot: ctx.cwd, runId, kind: 'egress-receipt-attestation', record });
  if (!persisted.ok) return { ok: false, diagnostic: (persisted.diagnostics ?? ['unknown write failure']).join('; '), proof: null };
  return { ok: true, diagnostic: null, proof: persisted.proof, idempotent: false };
}

async function runResume(ctx, opts) {
  const { pluginSet, validateRun } = await loadContext(ctx);
  const picked = await selectRun({ homeDir: ctx.homeDir, opts, defaultSelector: 'latest-open', validateRun });
  if (picked.error) {
    return { exitCode: picked.exitCode, report: { verb: 'resume', status: 'no-active-run', diagnostics: [picked.error === 'no-active-run' ? 'No open bootstrap run to resume (§3). Start with `runtime:bootstrap plan`.' : picked.error] } };
  }
  if (BOOTSTRAP_TERMINAL_RUN_STATUSES.includes(picked.manifest.status)) {
    return { exitCode: EXIT.NO_ACTIVE_RUN, report: { verb: 'resume', status: 'no-active-run', diagnostics: [`Run ${picked.run.run_id} is already ${picked.manifest.status}; resume operates on open runs only.`] } };
  }

  // §7 / ADR-0048 §1 — schema-minor gates on the ONE M1 verb:
  //   - a FUTURE minor is refused: this runtime would persist a document it
  //     only half-understands, silently shedding additions a newer runtime
  //     recorded (downgrade is never attempted, §4.6);
  //   - an OLDER minor migrates ADDITIVELY: the registry-new steps are already
  //     injected by the reprobe (expected derives from the current registry;
  //     judgeSteps carries prior state per step id), the new fragments render
  //     below, and the persist stamps the current schema string with a history
  //     row saying so — the pre-1.2 `...m` spread silently preserved the old
  //     stamp, leaving 1.2 content inside a document claiming 1.1.
  const docSchema = parseRunSchemaMinor(picked.manifest.schema);
  if (docSchema && docSchema.minor > READER_RUN_SCHEMA.minor) {
    return { exitCode: EXIT.INVALID, report: { verb: 'resume', status: 'refused', diagnostics: [`Run ${picked.run.run_id} carries schema ${picked.manifest.schema}, newer than this runtime's ${RUN_SCHEMA_VERSION} — resuming would persist a document this runtime only partially understands. Upgrade the runtime plugin (§4.6: downgrade is never attempted).`] } };
  }
  const migratingFromSchema = docSchema && docSchema.minor < READER_RUN_SCHEMA.minor ? picked.manifest.schema : null;

  // Answers are read BEFORE the reprobe so a fresh egress-proof opt-in (any
  // answer against proof.egress-provider-ack) reaches the expected-step
  // derivation — otherwise applyAnswers would reject the very answer that
  // requests the step (§6.1 unexpected-step gate).
  const answers = opts.answers ? await readAnswersFile(opts.answers) : [];
  const egressProofRequested = answers.some((a) => a.step_id === stepIds.proofEgressProviderAck());

  const reprobe = await reprobeAgainstRun(ctx, picked.manifest, pluginSet, { egressProofRequested });
  if (reprobe.proofReadFailure) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'resume', status: 'evidence-unreadable', diagnostics: reprobe.proofReadFailure } };
  }
  const { probe } = reprobe;
  // Rebindable: a hook-attestation import later in this verb supersedes the
  // evidence these steps were judged against, and the same resume must reflect it;
  // a plugin decline in THIS resume's answers narrows the selection, which changes
  // what the registry derives at all (§6.2).
  let steps = reprobe.steps;
  let selection = reprobe.selection;
  let effective = reprobe.effective;
  let expected = reprobe.expected;
  const warnings = [...(picked.warnings ?? []), ...(reprobe.foldWarnings ?? []), ...selectionRestoredWarnings(reprobe.selectionRestored, { window: "as of this run's re-probe", consequence: 'The selection was re-derived and the affected steps re-judged.' })];

  // `answeredEffective` is the per-step last-wins ANSWER map — a different thing from
  // the effective SELECTION above, and named apart so the two can never be confused
  // at a call site.
  //
  // The gate is handed the RETAINED selection, not the stored one (Refine-verify peer,
  // High). A plugin the reprobe already dropped has no rows left in `steps[]`, so a
  // gate reading `selection.desired` resurrects it — and with it the hard edge it
  // carried. A run whose `orchestrator` was declined earlier would refuse a new
  // `engineer` decline on the grounds that the very plugin the operator already
  // removed still requires it.
  const { choices, history, effective: answeredEffective } = applyAnswers({
    steps,
    answers,
    now: ctx.now,
    selection: { ...selection, desired: effective.plugins },
    pluginSet,
    verb: 'resume',
    expected,
    // §3.3 — the ledger this resume's answers are layered onto, so the value pass
    // can tell a CHANGED decision (which un-freezes the rendered hand-off) from a
    // re-sent identical answers file (which must not).
    priorChoices: Array.isArray(picked.manifest.choices) ? picked.manifest.choices : [],
  });

  // §3.3 — the standing decisions AFTER this resume's answers, folded once and
  // reused by every judgement below. The reprobe above judged against the
  // PERSISTED ledger only, because the answers grammar needs a judged
  // applicability before it can refuse anything — so a value step answered in
  // THIS resume is still carrying the previous verdict at this point.
  const foldedResume = foldStandingDecisions([
    ...(Array.isArray(picked.manifest.choices) ? picked.manifest.choices : []),
    ...choices,
  ], {
    // The document's OWN minor, not the reader's: resume stamps the current
    // schema on the way out, but the rows it is folding were written under the
    // minor the file still declares. Judging provenance against the post-write
    // stamp would authorize exactly the pre-dating rows the guard exists to
    // refuse.
    documentMinor: parseRunSchemaMinor(picked.manifest.schema)?.minor ?? null,
  });
  const standingNow = foldedResume.standing;
  warnings.push(...foldedResume.malformed, ...foldedResume.preDating);
  warnings.push(...dualKindWarningsFor(standingNow));

  // §6.2 — a plugin decline (this resume's, or one a legacy run recorded before the
  // narrowing existed) creates the effective `custom` selection. Re-derive and
  // re-judge BEFORE any proof executes: the executor binds versions against the
  // retained set, so running first would record a proof bound to the wrong selection.
  // The retained set from THIS resume's answers, layered on the one the reprobe
  // already resolved. The starting point is `effective.plugins`, not
  // `selection.desired`: a plugin the reprobe already dropped has no rows left in
  // `steps[]`, so re-deriving from the manifest's selection would resurrect it.
  const narrowedEffective = effectiveSelection({ pluginSet, selection: { desired: effective.plugins }, steps });
  const narrowed = narrowSelectionToEffective({ pluginSet, selection, effective: narrowedEffective });
  if (narrowed.changed) {
    history.push(selectionNarrowedHistoryRow({ before: selection, after: narrowed.selection, dropped: narrowed.dropped, at: new Date(ctx.now).toISOString() }));
    selection = narrowed.selection;
  }
  for (const refused of narrowed.refusedButRetained) warnings.push(refused.reason);
  // The hook verdict AFTER the narrowing. The §8.2 import gate below reads its status,
  // and reading the PRE-decline one would compute the gate from a different selection
  // than the import's own expected set (Refine-verify peer, Medium).
  //
  // Honest scope: the two agree in every state reachable today, so this is coherence
  // rather than a behaviour change. An attestation only reads `attested` while every
  // selected hook plugin is installed, and an installed plugin's step is `satisfied`,
  // which the answers grammar refuses to decline — so "attested, then narrowed to
  // stale in the same resume" has no route. Computing the gate from the selection the
  // import will actually use removes the question rather than resting on that.
  let hookVerdictNow = hookVerdictFor({ recordedAttestation: reprobe.recordedHookAttestation, pluginSet, effective, probe });
  if (!sameEffectiveSelection(effective, narrowedEffective)) {
    effective = narrowedEffective;
    expected = deriveExpectedSteps({
      pluginSet,
      selection: effective,
      permissionFragmentApplied: permissionFragmentAppliedFrom(steps),
      egressProofRequested: reprobe.egressOptIn,
    });
    const graph = validateStepGraph(expected);
    if (!graph.ok) throw new Error(`step registry produced an invalid graph (runtime bug): ${graph.errors.join('; ')}`);
    hookVerdictNow = hookVerdictFor({ recordedAttestation: reprobe.recordedHookAttestation, pluginSet, effective, probe });
    steps = judgeSteps({
      expected,
      probe,
      raw: reprobe.raw,
      pluginSet,
      readers: reprobe.readers,
      hookVerdict: hookVerdictNow,
      previousById: priorJudgeMapOf(steps),
      standing: standingNow,
      now: ctx.now,
    });
  }

  // LEDGER CAPACITY PREFLIGHT — asked HERE, before any effect, because the
  // effects below are not undoable and the validation that would catch an
  // over-cap ledger runs after them.
  //
  // `choices` and `history` are both `maxItems: 256` and NOTHING prunes either:
  // every answer row is appended deliberately, so the run stays replayable from
  // its own manifest. That was a footnote while answers were rare
  // accept/decline rows; a VALUE interview makes corrections ordinary (a
  // re-answer is one more row every time), so the cap becomes reachable in
  // normal use.
  //
  // The failure this closes is specific and bad: a resume carrying BOTH a value
  // answer and an `execute` would run the proof executor — a real doctor
  // subprocess, and for the egress kind a real network send — and only then fail
  // the manifest write, leaving the effect performed and unrecorded. Refusing
  // first costs an operator one diagnostic; refusing last costs them a proof
  // they cannot see.
  {
    const priorChoiceCount = Array.isArray(picked.manifest.choices) ? picked.manifest.choices.length : 0;
    const priorHistoryCount = Array.isArray(picked.manifest.history) ? picked.manifest.history.length : 0;
    // The migration rows this resume may still add: one schema-migration row,
    // plus one injection row per registry-new step. Counted rather than assumed
    // so the preflight refuses BEFORE the write instead of at it.
    // The injection rows this resume may add. Counted UNCONDITIONALLY, because
    // the mutate that writes them is unconditional: its own comment says a
    // runtime upgrade can widen the expected-step set WITHOUT a schema bump, so
    // gating the budget on `migratingFromSchema` under-counted exactly the
    // same-minor registry growth this change is an instance of — the preflight
    // would pass at the cap and the write would then fail, after Stage 8 had
    // already run (code review, MEDIUM). Only the schema-migration row itself
    // is conditional.
    const injectedRows = expected.filter((step) => !(picked.manifest.steps ?? []).some((row) => row.id === step.id)).length;
    const migrationHeadroom = (migratingFromSchema ? 1 : 0) + injectedRows;
    const overflow = [];
    if (priorChoiceCount + choices.length > LEDGER_MAX_ITEMS) {
      overflow.push(`choices would reach ${priorChoiceCount + choices.length} rows (cap ${LEDGER_MAX_ITEMS})`);
    }
    if (priorHistoryCount + history.length + migrationHeadroom > LEDGER_MAX_ITEMS) {
      overflow.push(`history would reach ${priorHistoryCount + history.length + migrationHeadroom} rows (cap ${LEDGER_MAX_ITEMS})`);
    }
    if (overflow.length > 0) {
      return {
        exitCode: EXIT.INVALID,
        report: {
          verb: 'resume',
          status: 'refused',
          reason: 'ledger-capacity',
          diagnostics: [
            `Run ${picked.run.run_id} cannot record this resume: ${overflow.join('; ')}. The ledgers are append-only by design — the run is replayable from its own manifest, so nothing is pruned — and nothing was executed, written, or rendered by this verb.`,
            'Recovery: close this run (`abandon`) and start a fresh `plan`, carrying the decisions forward in the answers file. A run that has accumulated this many rows has a history worth keeping as its own artifact rather than extending.',
          ],
        },
      };
    }
  }

  // Stage 8 — execute the proofs the operator explicitly approved (answer
  // `execute` on a proof step), through doctor's explicit executor flags.
  //
  // Transactional order (ADR-0048 §3): import+validate → PERSIST → re-read the
  // authoritative bytes → reduce → update the manifest. The pre-1.2 shape
  // pushed the in-memory record into the reduction before checking the write,
  // so a resume could reduce to `complete` — and terminalize — over a proof
  // file that never landed. Now a failed persist leaves that kind out of the
  // reduction entirely (warned, retryable on the next resume).
  //
  // EFFECTIVE actions only (ADR-0048 §3): the raw-answers filter this replaces
  // executed every `execute` row even when a later row declined the same step
  // — `execute` then `decline` still fired the proof the operator had just
  // withdrawn. applyAnswers' last-wins map is the single consumer surface.
  //
  // SECOND enforcement point for the same grammar, against the state that
  // exists HERE. `applyAnswers` refused every answer illegal at answer time,
  // but a legal pair can still leave an approval inert: declining a plugin
  // narrows the selection (§6.2), and the re-derivation above drops or
  // un-applies the proofs that plugin carried. The grammar cannot refuse that
  // combination — both answers were legal when given — so the executor skips
  // with a warning rather than running a proof this run no longer applies.
  // Observed on the model/effort slice's cross-host review: a proof declined
  // into non-applicability inside one resume still executed.
  // Applicability from the POST-narrowing expectation, for the same reason the
  // grammar reads it there: a restored `declined` overwrites the status this
  // used to test, so a declined-then-executed proof slipped straight through.
  const applicableNow = new Map(expected.map((s) => [s.id, s.applicable !== false]));
  const executeKinds = [];
  for (const [stepId, answer] of answeredEffective) {
    if (answer !== 'execute') continue;
    const kind = proofKindOf(stepId);
    // Unreachable through the answers file — the grammar refuses a non-proof
    // `execute` — but the executor states its own precondition rather than
    // inheriting it, because that inheritance is exactly what went missing.
    if (kind === null) continue;
    // Absent from the expectation is treated the same as not applicable: a
    // step this run does not enumerate is not one it may execute.
    const applicable = applicableNow.get(stepId);
    if (applicable !== true) {
      warnings.push(`proof ${stepId} was approved for execution, but this resume's own answers narrowed the selection until the run no longer applies it (§6.2); the approval stays recorded in choices[] and nothing ran`);
      continue;
    }
    executeKinds.push(kind);
  }
  let doctorReport = null;
  // The final-snapshot trigger is "a doctor subprocess was SPAWNED", not "its
  // evidence imported". The two used to be one flag, and the difference is the
  // whole point: a doctor that ran for nine minutes and then returned malformed
  // JSON, crashed, or produced an internally inconsistent section leaves nothing
  // imported — while the machine had nine minutes to move. Gating the re-probe on
  // the import made the failure path the one that reported stale facts, and (Codex
  // Refine-verify, MAJOR; reproduced) closed a run as complete over a plugin
  // removed mid-proof. A re-probe costs one probe and is never wrong; skipping one
  // after a long child is. The blocked-executor case that argued for the old flag —
  // doctor refusing fast, so nothing moved — is indistinguishable from the slow
  // failure at this seam, so it takes the conservative branch too.
  let doctorInvoked = false;
  for (const kind of executeKinds) {
    if (!PROOF_EXECUTE_FLAGS[kind]) {
      // Every current proof kind has a doctor executor (egress-provider-ack
      // joined with the egress-proof-executor slice), so this guard is now a
      // fail-closed backstop for a FUTURE kind whose executor has not landed:
      // the execute answer records the opt-in (the step is expected) but
      // nothing can run.
      warnings.push(`proof kind ${kind} has no doctor executor wired in this runtime; the step stays unexecuted (the opt-in is recorded)`);
      continue;
    }
    // Set BEFORE the await, and outside the ok/not-ok branch: the flag records
    // that a child was started, which is true the moment it is, and stays true
    // however that child ends.
    doctorInvoked = true;
    const result = await executeProofViaDoctor(ctx, { kind, probe, effective });
    if (!result.ok) {
      warnings.push(result.diagnostic);
      // A refused import may still carry a complete doctor report (the egress
      // blocked path records one) — reuse it for the hook attestation below.
      if (result.doctorReport) doctorReport = result.doctorReport;
      continue;
    }
    doctorReport = result.doctorReport ?? doctorReport;
    // A PASSED proof can still carry a WAL warning: the provider acked and the
    // mirror correlated (which is what `passed` means), while the intent record
    // that fences the NEXT attempt was not written durably. Doctor raises that
    // as an overall warning; the import only forwarded diagnostics when it
    // FAILED, so on the success path the warning died here and the operator was
    // never told the fence may not survive a reboot (peer round-3 MAJOR). It is
    // forwarded, not re-derived, so the two surfaces cannot drift.
    for (const warning of result.doctorReport?.overall?.warnings ?? []) {
      if (/intent WAL/i.test(warning)) warnings.push(`${kind}: ${warning}`);
    }
    const persisted = await writeBootstrapProof({ homeDir: ctx.homeDir, repoRoot: ctx.cwd, runId: picked.run.run_id, kind, record: result.record });
    if (!persisted?.ok) {
      // Egress is the ONE side-effecting proof: when its send already completed
      // and only the metadata write failed, the machine-global WAL now fences an
      // automatic re-send, so a bare resume would be BLOCKED. Advise reconcile-
      // then-clear rather than a blind retry — otherwise the proof-persist failure
      // recovery compounds into a duplicate send (follow-ups.md § "Egress-ack
      // intent WAL", gap 1 — cited by SECTION rather than by line, because the
      // line number this used to carry had already drifted onto an unrelated
      // Codex `plugin_hooks` row).
      const retryAdvice = kind === 'egress-provider-ack'
        ? 'the egress send may already have reached the phone; reconcile the phone, then re-run the egress proof once to get the blocker that NAMES which WAL records to remove (an attempt leaves a claim and a terminal record, and only the scan knows which are present and whether removing them is safe) before resuming'
        : 're-run resume to retry';
      warnings.push(`proof metadata for ${kind} could not be persisted (the run reduces without it; ${retryAdvice}): ${(persisted?.diagnostics ?? ['unknown write failure']).join('; ')}`);
    }
  }

  // The Codex /hooks attestation rides the same verb the same way (§8.2): a
  // doctor report fetched for a proof already carries the attestation section;
  // when none was fetched but the attestation step is still open, a read-only
  // doctor run would be R0-adjacent — resume is M1, so fetching one is
  // in-contract. `recordedHookAttestation` is the read-back evidence — an
  // already-persisted claim short-circuits the fetch exactly as the old
  // completion-cache did.
  //
  // The attestation lives at `settings_runs.codex_hook_review` — the currency
  // WRAPPER `{status, current, currency_reason, latest}` that doctor's
  // buildCodexHookReviewCurrency publishes — and never at the report's top
  // level. Reading the top-level key (#645) resolved `undefined` on every
  // report doctor can emit, so the import never ran, no hook-attestation record
  // was written, and the non-declinable `hooks.codex.attested` step could never
  // be satisfied on any hook-bearing bundle. `.latest` is the newest ATTESTING
  // run (doctor picks it explicitly), not `settings_runs.latest`, which is
  // whatever the newest settings run happened to be — frequently one that never
  // requested a review.
  //
  // Every non-importing branch below WARNS. The defect's real cost was silence:
  // the operator saw a pending non-declinable step whose recovery text told them
  // to do the thing they had already done, with no warning naming why it did not
  // take.
  //
  // The IMPORT GATE is bootstrap's own selection-scoped verdict, never doctor's
  // `current` (Refine-verify peer, High). Doctor judges the whole MACHINE: it
  // compares against `codex_plugin_hooks.summary.bundled_plugins` and blocks on
  // any disabled handler anywhere. Bootstrap judges a SELECTION: the importer
  // projects machine-wide evidence down to the selected plugins, and
  // recomputeHookAttestation skips disabled handlers for plugins outside it
  // (there is an explicit test for that). So a machine with `designer` disabled
  // reads not-current to doctor while an `engineering` selection of
  // engineer+orchestrator is legitimately attested — gating on doctor's verdict
  // would strand a step the reducer says is satisfiable. The version parsers
  // diverge too (doctor keeps SemVer build metadata and may fall back to cache
  // where bootstrap records `unknown`), so `current: true` would not even be a
  // sufficient gate in the other direction.
  //
  // Re-attempting on a STALE stored record is the other half. The old guard
  // short-circuited on mere presence, so once any record existed no later
  // attestation could ever replace it: re-attesting after a Codex upgrade
  // recorded a fresh claim that bootstrap never read, and the non-declinable
  // step's own "re-attest, then resume" recovery looped forever. That was
  // unreachable while the path bug kept the store empty, and reachable the
  // moment it was fixed. The gate is now the verdict, not the presence.
  const codexHookPlugins = codexHookBearingPlugins(pluginSet, effective.byHost.codex);
  const storedHookStatus = hookVerdictNow.status;
  let importedHookAttestation = null;
  if (codexHookPlugins.length > 0 && storedHookStatus !== 'attested') {
    if (!doctorReport) {
      const doctorPath = join(SCRIPT_DIR, 'doctor.mjs');
      // Read-only, but a child with a two-minute ceiling all the same, so it
      // triggers the final snapshot on the same "was one spawned" rule.
      doctorInvoked = true;
      const result = await ctx.subprocessRunner(doctorPath, ['--repo-root', ctx.cwd, '--format', 'json'], { cwd: ctx.cwd, env: scrubbedControlPlaneEnv(ctx.env), timeoutMs: 120_000 });
      // A non-zero exit here is the NORM, not a failure: this read happens on a
      // machine mid-bootstrap, whose hosts routinely still have hard failures.
      // Gating on `result.ok` would have stranded the attestation import on every
      // machine that needed it. A report that is not a plain object is still
      // rejected — `null`, `false`, `0` and `""` all parse, and each would slip
      // past every truthiness check below without a word (peer, Low).
      const read = readDoctorSubprocessReport(result);
      if (read.report) doctorReport = read.report;
      else warnings.push(`${read.diagnostic} for the Codex /hooks attestation; the attestation step stays open`);
    }
    // A MALFORMED section and an ABSENT one are different diagnoses and must not
    // collapse into one message: "nothing was attested yet" sends the operator to
    // /hooks, while a section (or a `latest`) that is present but not an object
    // means this runtime and its doctor disagree about the report shape, which
    // /hooks cannot fix (peer, round 3 — a truthy non-object review was reported
    // as "nothing recorded").
    const reviewRaw = doctorReport ? (doctorReport.settings_runs?.codex_hook_review ?? null) : null;
    const review = isPlainReportObject(reviewRaw) ? reviewRaw : null;
    const shapeAdvice = 'this runtime and its doctor disagree about the report shape — repair or upgrade the runtime plugin install (a second doctor run would return the same shape)';
    if (doctorReport && reviewRaw === null) {
      // Not a state a re-fetch can repair: doctor publishes this section
      // unconditionally, and both calls invoke the same sibling binary, so a
      // second identical subprocess would produce the same shape. Spawning one
      // would only hide a contract regression behind a silent extra run.
      warnings.push(`the doctor report carries no settings_runs.codex_hook_review section, so the Codex /hooks attestation could not be read; ${shapeAdvice}`);
    } else if (doctorReport && review === null) {
      warnings.push(`the doctor report's settings_runs.codex_hook_review is not an object, so the Codex /hooks attestation could not be read; ${shapeAdvice}`);
    } else if (review && review.latest === null) {
      // An EXPLICIT null is doctor's own encoding of "no attesting settings run
      // exists" — the one shape here that really is an empty machine rather than
      // a broken report, and the only one whose recovery is /hooks.
      warnings.push('no Codex /hooks attestation has been recorded on this machine, so nothing could be imported; review the bundled hooks with /hooks in an active Codex session, then run runtime:settings --attest-codex-hook-review and resume again');
    } else if (review && !isPlainReportObject(review.latest)) {
      // Anything else — an OMITTED `latest` key included — is a shape mismatch.
      // Doctor always emits the key, so its absence is not an empty machine, and
      // sending the operator to /hooks for it would be a recovery that cannot work.
      warnings.push(`the doctor report's recorded Codex /hooks attestation is ${review.latest === undefined ? 'missing' : 'not an object'}, so it could not be imported; ${shapeAdvice}`);
    } else if (review) {
      const imported = importHookAttestation(review.latest, { expectedPlugins: codexHookPlugins });
      if (imported.ok) {
        const persisted = await writeBootstrapProof({ homeDir: ctx.homeDir, repoRoot: ctx.cwd, runId: picked.run.run_id, kind: 'hook-attestation', record: imported.record });
        if (persisted?.ok) importedHookAttestation = imported.record;
        else warnings.push(`hook attestation metadata could not be persisted (the run reduces without it; re-run resume to retry): ${(persisted?.diagnostics ?? ['unknown write failure']).join('; ')}`);
      } else {
        warnings.push(`the recorded Codex /hooks attestation is not importable for this selection: ${imported.errors.join('; ')}`);
      }
    }
  }

  // D0.1 — the owner receipt testimony, resume half. `effective` is last-wins
  // per step, so `execute` and `attest-receipt` against the ack step in one
  // file resolve to ONE action — executing and testifying in the same resume
  // is structurally impossible, which is exactly the after-the-fact property
  // D0.1 demands (testimony needs a PRE-EXISTING passed ack; the terminal-run
  // path is the `attest` verb).
  if (answeredEffective.get(stepIds.proofEgressProviderAck()) === 'attest-receipt') {
    const attest = await recordReceiptAttestation(ctx, { runId: picked.run.run_id, proofRecords: reprobe.proofRecords, ackEvaluated: reprobe.completion.proofs.find((p) => p.kind === 'egress-provider-ack') ?? null });
    if (!attest.ok) warnings.push(`attest-receipt was not recorded: ${attest.diagnostic}`);
  }

  // ── THE FINAL SNAPSHOT ─────────────────────────────────────────────────────
  //
  // A proof executor can run for minutes; judging its freshness against the
  // PRE-execution probe would compare a snapshot against itself and could mark
  // drifted evidence current (Codex review MAJOR). So whenever a doctor child was
  // spawned at all — see `doctorInvoked` for why the trigger is the spawn and not
  // the import — re-probe: the final reduction, the persisted probe and the judged
  // rows all reflect the post-execution machine, so a CLI/plugin that moved
  // mid-proof re-judges the evidence stale instead of complete.
  //
  // RAW rides along, not just the serialized probe. `judgeSteps` reads both —
  // host presence and marketplace registration come from `raw`, versions and
  // auth from `probe` — and `buildStage0` reads both too, so re-probing while
  // keeping the old `raw` would just move the mismatch one field over.
  //
  // The READERS re-read is the same rule for the ACTIVATION half (Plan-verify
  // peer): the egress ack's freshness equality compares its recorded
  // activation_fingerprint against the CURRENT activation — judged from the
  // pre-execution readers, a just-recorded ack could be marked stale (or a
  // stale one current) when the operator changed channel/recipient mid-proof.
  //
  // ONE `probeNow`, not one per consumer: two probes taken seconds apart under a
  // single run_id would let this verb report two different machines and call
  // both "the state at completion".
  const executedSnapshot = doctorInvoked ? await probeNow(ctx) : null;
  const finalProbe = executedSnapshot ? executedSnapshot.probe : probe;
  const finalRaw = executedSnapshot ? executedSnapshot.raw : reprobe.raw;
  const finalReaders = doctorInvoked ? await readUserGlobalReaders(ctx) : reprobe.readers;

  // Reduce from the authoritative bytes: everything the executors persisted is
  // read back — validated, hashed — and ONLY that evidence reaches the reducer.
  // It reaches the JUDGEMENT below too. The step judge used to read the hook
  // attestation from the in-memory import while the reducer read it from disk;
  // the two agree in every state reachable today (a failed persist leaves the
  // import null, so neither sees it), which makes this coherence rather than a
  // behaviour change — but "judged from one copy, reduced from another" is the
  // same shape as the probe mismatch the reconstruction below exists to remove,
  // and one source settles it instead of resting on that reachability argument.
  const finalRead = await readBootstrapProofRecords({ homeDir: ctx.homeDir, runId: picked.run.run_id });
  if (!finalRead.ok) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'resume', status: 'evidence-unreadable', diagnostics: finalRead.errors } };
  }
  const proofs = finalRead.records.filter((r) => PROOF_KINDS.includes(r.kind)).map((r) => r.record);
  const hookAttestation = finalRead.records.find((r) => r.kind === 'hook-attestation')?.record ?? null;
  const finalReceiptRow = finalRead.records.find((r) => r.kind === 'egress-receipt-attestation') ?? null;
  const finalAckRow = finalRead.records.find((r) => r.kind === 'egress-provider-ack') ?? null;

  // ── ONE RECONSTRUCTION FROM THE FINAL SNAPSHOT ─────────────────────────────
  //
  // Two things move the machine out from under the judgement this verb already
  // made, and BOTH land here:
  //
  //   1. an executor — or the read-only doctor fetch above it — runs for
  //      minutes, so `finalProbe` / `finalRaw` / `finalReaders` describe a
  //      machine the steps were never judged against;
  //   2. a Codex /hooks attestation imported ABOVE was judged into `steps`
  //      before it existed (reprobeAgainstRun reads proof/ and judges in one
  //      pass, and the import comes after), so the reduction would pair a fresh
  //      `attested` verdict with a still-`pending` step and report the run
  //      incomplete — completion needs both. The operator's symptom was that the
  //      resume which finally imported the claim still showed the step pending,
  //      and only a SECOND resume satisfied it: the same "do the thing you
  //      already did" loop #645 is about, one step further on.
  //
  // Case 2 used to be handled here alone, and it re-judged against the
  // PRE-execution probe/raw/readers while computing the hook verdict against
  // `finalProbe` — one judge call reading two different machines. Case 1 was
  // recorded as a known defect and left standing: the run persisted `finalProbe`
  // beside steps judged from the older one, Stage 0 was built from the older one
  // too, and the report returned that older probe to the caller — so the
  // manifest and the JSON disagreed about the machine state the completion was
  // judged from. Returning `finalProbe` from the report would have made those
  // two agree while leaving both disagreeing with the steps inside them; the
  // repair is one reconstruction that every consumer below (reduction, persist,
  // fragments, Stage 0, report) reads.
  //
  // Re-judge against THIS RESUME'S CURRENT steps, not the pre-answer snapshot.
  // applyAnswers mutates step rows in place — a decline sets `declined` and
  // withdraws the fragment pointer, apply command and desired state — and it has
  // already run by the time execution or the import happens. Re-judging from the
  // pre-answer map (the first cut of the case-2 fix) silently discarded those
  // mutations: the operator's decline stayed in `choices` and `history` while the
  // step itself reverted to `pending` with its refused hand-off restored, and
  // because the reducer reads `declined` off the step row rather than the choice
  // ledger, a declined proof could even lose its completion cap. Feeding the
  // post-answer rows through the same normalization is exactly how declines
  // already survive from one resume to the next: judgeSteps re-asserts `declined`
  // from `previous` for a declinable step whose fresh observation is not
  // satisfied.
  //
  // The hook row is not the only row that may move, and claiming so would be
  // wrong (peer, round 3): the graph pass runs again over the ANSWERED rows, so a
  // dependent the first pass demoted to `blocked` behind a now-declined
  // predecessor correctly converges to `pending` here — declines count as
  // resolved. That is earlier convergence to the same answer, not a new verdict:
  // both `blocked` and `pending` are unresolved to the reducer, so no run
  // completes on it.
  //
  // UNCONDITIONAL. The gate this replaces skipped the pass when no doctor child
  // ran and nothing was imported, on the grounds that the inputs would be
  // identical — and they are not: `applyAnswers` mutates step rows in place
  // between the reprobe's judge and here. Measured on `base` with `accept
  // proof.egress-provider-ack` + `decline egress.configured` and no executor,
  // the skip left resume reporting that proof `blocked` with "resolve
  // egress.configured first" while the SAME report showed that predecessor
  // `declined`, and an immediate `status` reported it `pending` (cross-host
  // Review peer, MINOR; reproduced). The graph pass has to run over the answered
  // rows for the two to agree. When the snapshot genuinely did not move this is
  // one extra pure judgement over the same probe — the cost of the verb agreeing
  // with the next one about its own rows.
  {
    const previousForFinalJudge = priorJudgeMapOf(steps);
    let finalHookVerdict = hookVerdictFor({ recordedAttestation: hookAttestation, pluginSet, effective, probe: finalProbe });
    // `expected` — not `reprobe.expected` — because a decline in THIS resume may
    // already have re-derived it against the narrowed selection. The verdict is a
    // PARAMETER rather than a closed-over binding: the second pass may recompute
    // it, and a closure read at call time is a timing detail nobody should have to
    // hold in their head to know which verdict a judgement used.
    // §3.3 — `standingNow` is the ledger INCLUDING this resume's answers, and
    // this unconditional pass is what makes a value answer correct: judgement
    // necessarily runs before `applyAnswers` (the grammar needs a judged
    // applicability), so every earlier pass saw the previous standing decision.
    // The same reasoning the unconditional-ness above rests on applies to values
    // exactly as it does to declines.
    const judgeFinal = (expectation, hookVerdict) => judgeSteps({
      expected: expectation,
      probe: finalProbe,
      raw: finalRaw,
      pluginSet,
      readers: finalReaders,
      hookVerdict,
      previousById: previousForFinalJudge,
      standing: standingNow,
      now: ctx.now,
    });
    const fragmentAppliedBefore = permissionFragmentAppliedFrom(steps);
    steps = judgeFinal(expected, finalHookVerdict);

    // THE EXPECTATION'S OWN INPUTS MOVE WITH THE SNAPSHOT — so the second pass
    // reprobeAgainstRun already runs against the earlier snapshot runs again
    // here, over BOTH inputs `deriveExpectedSteps` reads. One re-derivation
    // covering both, because they are the same question asked of two fields.
    //
    // (1) `fragment_applied` is PROMOTED by judgeSteps when a rendered fragment is
    // first observed applied, and the expectation reads it to decide whether
    // `proof.permission` applies at all. An operator who applies the permission
    // fragment while a long proof runs is observed for the first time HERE, so a
    // reconstruction that reused the pre-execution expectation would rebuild the
    // snapshot around an applicability the snapshot itself disproves — and, since
    // applicability became a REFUSAL at the answer boundary, would hand the next
    // resume an exit 40 on an ordinary flow.
    //
    // (2) The EFFECTIVE SELECTION is derived from `declined` step rows and nothing
    // else, and §6.2 lets a satisfying observation clear a decline (judgeSteps'
    // restore rule is explicitly conditioned on `status !== 'satisfied'`). The
    // registry keeps a host-scoped decline's row in the expectation on purpose —
    // `selection.desired` is a flat name list, so the ROW is the only place a
    // partial refusal lives — which is exactly what makes it re-judgeable here. An
    // operator who installs, during the proof, a plugin they had refused on that
    // host therefore erases the evidence `effective` was derived from, and the
    // run went on to BIND VERSIONS, judge hooks and reduce against the superseded
    // exclusion: measured, that closed a run as `complete` (exit 0) whose very
    // next `status` read `incomplete` (exit 20) — and a terminal run is one
    // `resume` refuses, so the operator was stranded.
    //
    // BOUNDED, and the bound is structural rather than a retry cap: the retained
    // PLUGIN set cannot move here at all. `effectiveSelection` is asked about
    // `effective.plugins`, so its answer is a subset of that; removing a plugin
    // needs a fully-refused one; and judgeSteps only ever RESTORES declines from
    // `previous`, never invents them — so the decline set can only shrink and
    // `fullyRefused` can only go false. Only `byHost` moves, only wider, and the
    // re-judged rows that widened it are `satisfied` (that is why their decline
    // vanished), so a third derivation would return the second one's answer.
    // Nothing plugin-level changes, which is why the persisted
    // `{bundle, desired, excluded}` selection is deliberately NOT rewritten and no
    // narrowing history row is pushed: §7 states narrowing is not reversible
    // in-run, and this reverses none — a host-scoped exclusion is re-derived by
    // EVERY verb from the rows (§6.2), so this only computes here what `status`
    // and the next `resume` would compute anyway.
    const fragmentAppliedAfter = permissionFragmentAppliedFrom(steps);
    const convergedEffective = effectiveSelection({ pluginSet, selection: { desired: effective.plugins }, steps });
    const fragmentMoved = ['claude', 'codex'].some((h) => fragmentAppliedAfter[h] !== fragmentAppliedBefore[h]);
    const selectionMoved = !sameEffectiveSelection(effective, convergedEffective);
    if (fragmentMoved || selectionMoved) {
      if (selectionMoved) {
        warnings.push(...selectionRestoredWarnings(
          ['claude', 'codex']
            .map((host) => ({ host, plugins: (convergedEffective.byHost[host] ?? []).filter((name) => !(effective.byHost[host] ?? []).includes(name)) }))
            .filter((row) => row.plugins.length > 0),
          { window: "during this resume's doctor child", consequence: 'The selection was re-derived and the affected steps re-judged.' },
        ));
        effective = convergedEffective;
        finalHookVerdict = hookVerdictFor({ recordedAttestation: hookAttestation, pluginSet, effective, probe: finalProbe });
      }
      expected = deriveExpectedSteps({
        pluginSet,
        selection: effective,
        permissionFragmentApplied: fragmentAppliedAfter,
        egressProofRequested: reprobe.egressOptIn,
      });
      const graph = validateStepGraph(expected);
      if (!graph.ok) throw new Error(`step registry produced an invalid graph (runtime bug): ${graph.errors.join('; ')}`);
      steps = judgeFinal(expected, finalHookVerdict);
    }

    // An imported claim that does not stand for THIS selection leaves the step
    // open on purpose — say why, with the selection-scoped reasons, rather than
    // letting the operator re-attest into the same outcome. Gated on the IMPORT:
    // a run that merely executed a proof under an already-stale stored
    // attestation has nothing new to say about it.
    if (importedHookAttestation && finalHookVerdict.status !== 'attested') {
      warnings.push(`the imported Codex /hooks attestation does not hold for this selection (${finalHookVerdict.status}): ${finalHookVerdict.reasons.join('; ')}`);
    }
  }

  const completion = reduceCompletion({
    pluginSet,
    selection: effective,
    steps,
    // The SAME union the persist below writes (`[...m.choices, ...choices]`):
    // reducing over the pre-answer ledger would judge this resume's own opt-in
    // absent, so an `execute` answer would report the proof it just authorized as
    // not-applicable.
    choices: [...(Array.isArray(picked.manifest.choices) ? picked.manifest.choices : []), ...choices],
    proofs,
    hookAttestation,
    probe: finalProbe,
    runtimeVersion: RUNTIME_VERSION,
    currentActivationFingerprint: currentActivationFingerprintOf(finalReaders),
    receiptEvidence: finalReceiptRow ? { record: finalReceiptRow.record, providerAckSha256: finalAckRow?.sha256 ?? null } : null,
  });

  // M1 persist — invalidation stamps, transitions, choices, proofs, and the
  // (possibly terminal) status. The transition rule is asymmetric on purpose
  // (Codex Plan-verify blocker): `configured-not-verified` is a REDUCTION the
  // moment CONFIG resolves with no proof recorded, but closing the run there
  // would make Stage 8 unreachable — `resume --latest-open` could never find
  // it again to record the very proofs it is missing. So: `complete` closes;
  // `configured-not-verified` closes ONLY when every required proof was
  // explicitly declined (§6.2 — nothing is left for resume to produce); any
  // other state stays open, and the exit code still reports the reduction.
  const requiredProofs = (completion.proofs ?? []).filter((proof) => proof.required);
  const everyProofDeclined = requiredProofs.length > 0 && requiredProofs.every((proof) => proof.declined);
  const nextStatus = completion.state === 'complete'
    ? 'complete'
    : completion.state === 'configured-not-verified' && everyProofDeclined
      ? 'configured-not-verified'
      : 'open';

  // Fragments re-render on EVERY open resume (ADR-0048 §1), not only on a
  // schema migration: a fragment write that failed last time gets retried,
  // and a registry-new step within the same schema gets its fragment too.
  // persist's skip rules (satisfied/declined/not-applicable) already prevent
  // re-rendering what the operator has resolved.
  // FINAL readers, like everything else this verb emits: a fragment renders the
  // configuration the operator is about to apply, so composing it from the
  // pre-execution snapshot would hand them a command built around reader state
  // the same resume has already superseded.
  await composeFragments({ homeDir: ctx.homeDir, cwd: ctx.cwd, env: ctx.env, runId: picked.run.run_id, now: ctx.now, steps, warnings, readersForFragments: finalReaders, standingForFragments: standingNow });

  // The migration row derives from the LOCKED read inside mutate (Codex review
  // MAJOR): deciding it from the pre-lock snapshot let two concurrent resumes
  // of one legacy run each append their own 1.1→1.2 row. `m.schema` under the
  // lock is the authority — already-stamped means no row.
  const migrationRowAt = new Date(ctx.now).toISOString();
  const updated = await updateBootstrapRun({
    homeDir: ctx.homeDir,
    repoRoot: ctx.cwd,
    runId: picked.run.run_id,
    now: ctx.now,
    validate: validateRun,
    mutate: (m) => ({
      ...m,
      schema: RUN_SCHEMA_VERSION,
      status: nextStatus,
      probe: finalProbe,
      // §6.2 — the narrowed selection is PERSISTED, in the same atomic mutate as the
      // steps derived from it. Writing the steps without it would strand the run: the
      // declined plugin's rows are gone from `steps[]` (they are no longer expected),
      // so the next verb would re-derive the ORIGINAL selection from a manifest with
      // no decline left to read, and the narrowing would silently revert.
      selection,
      steps,
      choices: [...(Array.isArray(m.choices) ? m.choices : []), ...choices],
      history: [
        ...(Array.isArray(m.history) ? m.history : []),
        ...(m.schema !== RUN_SCHEMA_VERSION
          ? [{ step_id: null, from: m.schema, to: RUN_SCHEMA_VERSION, reason: 'schema migrated additively on resume (ADR-0048 §1): registry-new steps injected, fragments re-rendered', at: migrationRowAt }]
          : []),
        // SAME-MINOR registry growth (statusline peer B5): a runtime upgrade
        // can widen the expected-step set without a schema bump — §7 treats
        // that like any other invalidation (expectations re-open honestly),
        // and each injected step gets its own history row so the run's
        // account explains where the new obligation came from.
        ...steps
          .filter((step) => !(Array.isArray(m.steps) && m.steps.some((prev) => prev?.id === step.id)))
          .map((step) => ({ step_id: step.id, from: null, to: step.status, reason: 'step injected by a newer runtime registry (ADR-0048 §7 — expectations widen with the runtime)', at: migrationRowAt })),
        ...history,
      ],
      completion,
    }),
  });
  if (!updated.updated) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'resume', status: 'persist-failed', reason: updated.reason, diagnostics: updated.diagnostics } };
  }

  // The same warning at the LAST moment it is still actionable. Gated on the run
  // staying OPEN: once `nextStatus` is terminal the door has already shut, and a
  // warning telling the operator to opt in would be an epitaph rather than an
  // instruction. This is the resume half of the failure the plan warning names —
  // and the half that actually bit, because a proof run SPLIT across resumes
  // terminalizes on the first one whose owed set happens to pass.
  if (nextStatus === 'open') {
    warnings.push(...optInProofWarnings({ expected }));
  }

  const stage0 = buildStage0(finalProbe, finalRaw);
  const report = {
    verb: 'resume',
    run_id: picked.run.run_id,
    run_status: nextStatus,
    selection,
    completion,
    steps,
    value_decisions: valueDecisionRows(standingNow),
    stage0,
    // The SAME probe the steps above were judged against, the reduction was
    // computed from, and the manifest now stores — one machine state per
    // resume, reported once.
    probe: finalProbe,
    warnings,
    diagnostics: updated.diagnostics,
  };
  return { exitCode: EXIT_BY_STATE[completion.state] ?? EXIT.UNEXPECTED, report };
}

/**
 * D0.1 — the post-terminal receipt door. A successful final proof send
 * terminalizes the run (resume then refuses it), so the owner's after-the-fact
 * phone-receipt testimony needs a verb of its own. It is APPEND-ONLY in the
 * narrowest sense: the one artifact it may produce is the receipt attestation
 * file (the writer's postTerminalWritable exception); the manifest — steps,
 * proofs, status, stored completion — is never touched. The verdict the
 * testimony earns is recomputed and REPORTED here, and by every later
 * status/verify, from the recorded evidence (§7: records are choices and
 * history, never truth).
 */
async function runAttest(ctx, opts) {
  const { pluginSet, validateRun } = await loadContext(ctx);
  const picked = await selectRun({ homeDir: ctx.homeDir, opts, defaultSelector: 'latest', validateRun });
  if (picked.error) {
    return { exitCode: picked.exitCode, report: { verb: 'attest', status: 'no-active-run', diagnostics: [picked.error === 'no-active-run' ? 'No bootstrap run exists to attest against (§3).' : picked.error] } };
  }
  if (picked.manifest.status === 'abandoned') {
    return { exitCode: EXIT.INVALID, report: { verb: 'attest', status: 'refused', diagnostics: [`Run ${picked.run.run_id} is abandoned — an abandoned run is an escape hatch, not a completed bootstrap anyone can testify about.`] } };
  }
  // Open runs testify through `resume --answers` (attest-receipt), whose
  // choices[] rows are the audit trail; the attest verb exists ONLY for the
  // post-terminal window where resume refuses the run (D0.1). Accepting open
  // runs here would open an unaudited side door (Codex review MAJOR).
  if (picked.manifest.status === 'open') {
    return { exitCode: EXIT.INVALID, report: { verb: 'attest', status: 'refused', diagnostics: [`Run ${picked.run.run_id} is open — testify through \`resume --answers\` (an attest-receipt answer), which audit-logs the choice in the manifest; attest is the post-terminal door only (D0.1).`] } };
  }
  // Receipt testimony is a 1.2-vocabulary artifact: a legacy-schema run has no
  // receipt verdict seat and is presented as immutable history, so testimony
  // against it would be unreadable evidence. An OPEN legacy run migrates on
  // resume first; a terminal one needs a fresh run for 1.2 evidence.
  if (picked.manifest.schema !== RUN_SCHEMA_VERSION) {
    return { exitCode: EXIT.INVALID, report: { verb: 'attest', status: 'refused', diagnostics: [`Run ${picked.run.run_id} carries schema ${picked.manifest.schema}, not ${RUN_SCHEMA_VERSION} — attest records CURRENT-schema evidence only. Resume an open legacy run to migrate it first; a terminal legacy run stays immutable history.`] } };
  }

  // NOT converged (§7, owner decision): the receipt door judges the run as the
  // run was REDUCED, so a selection that lapsed after the run closed cannot
  // refuse testimony about a send that already happened. See reprobeAgainstRun's
  // `converge` parameter for the full reasoning and the cost.
  const reprobe = await reprobeAgainstRun(ctx, picked.manifest, pluginSet, { converge: false });
  if (reprobe.proofReadFailure) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'attest', status: 'evidence-unreadable', diagnostics: reprobe.proofReadFailure } };
  }
  // The cost, said out loud on every affected run — the one thing that must not
  // happen is attest and status disagreeing about a run in silence.
  const attestWarnings = selectionRestoredWarnings(reprobe.selectionRestored, {
    window: 'as of this re-probe',
    // NOT the converged wording: attest deliberately did not re-derive, and a
    // warning that claimed it had would be one more sentence describing
    // behaviour the code does not have.
    consequence: 'attest deliberately does NOT re-derive it — the receipt door judges this run as it was REDUCED (§7: its subject is a send that already happened), so this verdict can differ from what `status` reports for the same run.',
  });

  const attest = await recordReceiptAttestation(ctx, {
    runId: picked.run.run_id,
    proofRecords: reprobe.proofRecords,
    ackEvaluated: reprobe.completion.proofs.find((p) => p.kind === 'egress-provider-ack') ?? null,
  });
  if (!attest.ok) {
    return { exitCode: EXIT.INVALID, report: { verb: 'attest', status: 'refused', diagnostics: [attest.diagnostic], warnings: attestWarnings } };
  }

  // Re-read and re-reduce so the reported verdict is computed over the exact
  // bytes just persisted — the same authoritative-bytes rule resume follows.
  const finalRead = await readBootstrapProofRecords({ homeDir: ctx.homeDir, runId: picked.run.run_id });
  if (!finalRead.ok) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'attest', status: 'evidence-unreadable', diagnostics: finalRead.errors, warnings: attestWarnings } };
  }
  const receiptRow = finalRead.records.find((r) => r.kind === 'egress-receipt-attestation') ?? null;
  const ackRow = finalRead.records.find((r) => r.kind === 'egress-provider-ack') ?? null;
  const completion = reduceCompletion({
    pluginSet,
    selection: reprobe.effective,
    steps: reprobe.steps,
    choices: picked.manifest.choices,
    proofs: finalRead.records.filter((r) => PROOF_KINDS.includes(r.kind)).map((r) => r.record),
    hookAttestation: finalRead.records.find((r) => r.kind === 'hook-attestation')?.record ?? null,
    probe: reprobe.probe,
    runtimeVersion: RUNTIME_VERSION,
    currentActivationFingerprint: currentActivationFingerprintOf(reprobe.readers),
    receiptEvidence: receiptRow ? { record: receiptRow.record, providerAckSha256: ackRow?.sha256 ?? null } : null,
  });

  const report = {
    verb: 'attest',
    run_id: picked.run.run_id,
    run_status: picked.manifest.status,
    receipt: completion.egress_receipt_attestation ?? null,
    receipt_pointer: attest.proof.pointer,
    completion,
    warnings: attestWarnings,
    diagnostics: [],
  };
  return { exitCode: EXIT.OK, report };
}

async function runAbandon(ctx, opts) {
  let runId = opts.run_id ?? null;
  if (!runId) {
    // Abandon is the RECOVERY verb, so its default selection must not pass
    // through selectRun's schema gate — an invalid open manifest is exactly
    // what abandon exists to close, and a validating selector would refuse to
    // name it. Only the ID is needed here; nothing reads the body.
    const scan = await scanBootstrapRuns({ homeDir: ctx.homeDir });
    const open = scan.status === 'available' ? scan.runs.find((r) => r.status === 'open') ?? null : null;
    if (!open) {
      return { exitCode: EXIT.NO_ACTIVE_RUN, report: { verb: 'abandon', status: 'no-active-run', diagnostics: ['No open bootstrap run to abandon.'] } };
    }
    runId = open.run_id;
  }
  const result = await abandonBootstrapRun({
    homeDir: ctx.homeDir,
    repoRoot: ctx.cwd,
    runId,
    reason: opts.reason ?? 'operator abandoned the run',
    now: ctx.now,
  });
  if (!result.abandoned) {
    if (result.reason === 'already-terminal') {
      // Idempotent: the recorded terminal status is reported, never rewritten.
      return { exitCode: EXIT.OK, report: { verb: 'abandon', run_id: runId, status: result.status, diagnostics: result.diagnostics } };
    }
    return {
      exitCode: result.reason === 'run-missing' ? EXIT.NO_ACTIVE_RUN : EXIT.UNEXPECTED,
      report: { verb: 'abandon', run_id: runId, status: 'refused', reason: result.reason, diagnostics: result.diagnostics },
    };
  }
  return { exitCode: EXIT.OK, report: { verb: 'abandon', run_id: runId, status: 'abandoned', diagnostics: result.diagnostics } };
}

async function readProfileFile(ctx, path) {
  const text = await readBoundedFile(path, '--profile-file');
  let profile;
  try {
    profile = JSON.parse(text);
  } catch (err) {
    // D1 §3.2 — the mirror of the `--answers` guard above. Both read an
    // untrusted operator-authored file through JSON.parse, whose message
    // quotes the input; fixing one and not the other left the identical leak
    // one flag away.
    throw new UsageError(`--profile-file is not valid JSON${jsonParsePosition(err)}; the parser's message is withheld because it quotes the file's own bytes (§3.2)`);
  }
  const { validateProfile, profileSchema } = await loadContext(ctx);
  const verdict = validateProfile(profile);
  if (!verdict.ok) {
    throw new UsageError(`the profile failed §4 validation: ${verdict.errors.join('; ')}`);
  }
  const gate = profileWriteGate({ schemaValidate: validateProfile, original: profile, homeDir: ctx.homeDir })(profile);
  if (!gate.ok) {
    throw new UsageError(`the profile failed the §4.3 guards: ${gate.errors.join('; ')}`);
  }
  // §4.6 — validator warnings SURFACE (ADR-0048 peer finding): a newer-minor
  // document's ignored scalar (e.g. a 1.1 statusline_preset under a 1.0-era
  // reader) must be visible to the operator, not silently discarded — an
  // invisible warning is how a forward-compat rule stops being exercised.
  return { profile, hash: profileHash(profile, profileSchema), profileId: basenameNoExt(path), warnings: verdict.warnings ?? [] };
}

function basenameNoExt(path) {
  const base = String(path).split(/[\\/]/).pop() ?? '';
  return base.replace(/\.json$/i, '');
}

// The builder inputs the artifact CANNOT be checked against — the pre-sanitize source
// the §4.3 guard-1 scrub exists for, and nothing else.
//
// `buildMachineProfile` copies almost everything through verbatim (`field()` is
// `value ?? null`), so a secret in `modelEffort` or `notify` lands IN the profile and
// the profile-side half of the same guard catches it. Exactly one input is LOSSY:
// the Claude permission arrays go through `sanitizeValue`, which rewrites a token to
// `<redacted-token>`. That is the only place the artifact can be a laundered version
// of its source, so it is the only place a source-side scan adds anything.
//
// Passing the whole `readUserGlobalReaders` bundle instead was measured as a real
// regression, by both review lanes independently: it carries `statuslineClaude`,
// `statuslineCodex`, `codexNotify` and `egressActivation`, which are read for
// JUDGEMENT and never projected — and `projectClaudeStatusline` documents its raw
// foreign command as possibly carrying secrets. Gating on them refused exports over
// values the profile provably cannot contain, with no remedy but editing host config.
// A guard must refuse what could leak, not everything the machine happens to hold.
function lossyProfileInputs(readers) {
  const claude = readers?.claudePermission ?? {};
  return { claudePermission: { allow: claude.allow ?? [], ask: claude.ask ?? [], deny: claude.deny ?? [] } };
}

async function runProfileExport(ctx, opts) {
  const { pluginSet, validateProfile, profileSchema, validateRun } = await loadContext(ctx);
  const name = opts.name ?? 'default';
  validateProfileName(name);

  let selection;
  let probe;
  let fromRunManifest = null;
  if (opts.from_run) {
    const picked = await selectRun({ homeDir: ctx.homeDir, opts: { run_id: opts.from_run }, defaultSelector: 'run-id', validateRun });
    if (picked.error) {
      return { exitCode: picked.exitCode, report: { verb: 'profile export', status: 'no-such-run', diagnostics: [picked.error] } };
    }
    // §6.2 — export the EFFECTIVE selection, for the same reason the statusline
    // decline is honoured below: a profile is seed material, so exporting a plugin
    // this run's operator declined would resurrect it on the next `plan
    // --profile-file` — the decline undone by a round trip through the artifact
    // meant to reproduce the machine. A run already narrowed by resume is unchanged
    // by this; a legacy one is corrected on the way out.
    selection = narrowSelectionByDeclines({ pluginSet, selection: picked.manifest.selection, steps: picked.manifest.steps ?? [] }).selection;
    fromRunManifest = picked.manifest;
    ({ probe } = await probeNow(ctx));
  } else {
    // §3 — with no run, the profile exports the LIVE probe: bundle `custom`,
    // desired = the observed installed set (which is, empirically, exactly what
    // this machine chose), excluded empty.
    ({ probe } = await probeNow(ctx));
    const installed = new Set();
    for (const host of ['claude', 'codex']) {
      for (const [pluginName, entry] of Object.entries(probe.hosts[host].plugins)) {
        if (entry.state === 'installed' || entry.state === 'disabled') installed.add(pluginName);
      }
    }
    selection = { bundle: 'custom', desired: [...installed].sort(), excluded: [] };
  }

  // §4.4 — user-global-only readers; repository-effective values are never
  // exported and never relabelled.
  const readers = await readUserGlobalReaders(ctx);
  // ADR-0048 §2.1 / statusline peer G6 (owner-approved 2026-07-23): the
  // profile carries the preset when BOTH hosts' statusline configuration is
  // observed CANONICAL — the operator applying the rendered agentic-6
  // fragments IS the declaration; anything less (one host, declined, foreign)
  // exports null. Observation-of-an-applied-fragment is not inference from
  // arbitrary host config: only the exact canonical forms count.
  const slC = readers.statuslineClaude;
  const slX = readers.statuslineCodex;
  const claudeCanonical = slC?.readable === true && slC.present === true && slC.type === 'command' && slC.command === slC.expectedCommand;
  const codexCanonical = slX?.readable === true && Array.isArray(slX.items)
    && slX.items.length === slX.expectedItems.length && slX.expectedItems.every((item, i) => item === slX.items[i]);
  // --from-run honours that run's DECLINES (Review peer MAJOR / §6.1.1
  // declined→null): a run whose operator declined the statusline steps must
  // not later export the preset off live config.
  const statuslineDeclined = fromRunManifest
    ? (fromRunManifest.steps ?? []).some((step) => (step?.id === 'statusline.claude.configured' || step?.id === 'statusline.codex.configured') && step?.status === 'declined')
    : false;
  readers.statuslinePreset = claudeCanonical && codexCanonical && !statuslineDeclined ? STATUSLINE_PRESET_AGENTIC_6 : null;
  const profile = buildMachineProfile({
    readers,
    probe,
    selection,
    runtimeVersion: RUNTIME_VERSION,
    hostname: ctx.hostname,
    now: ctx.now,
  });

  // CANONICALIZE BEFORE WRITING. `profileWriteGate`'s own docstring says "canonical
  // order applied before the bytes are produced", and it was not: `writeMachineProfile`
  // serializes whatever object it is handed, so the bytes on disk carried the BUILDER's
  // insertion order while `profileHash` hashed the canonical form. They agreed only
  // because the builder happened to emit keys in schema order — a coincidence, and one
  // this change made fragile by introducing a second order source (PROFILE_SESSION_KEYS)
  // alongside the schema. Reproduced by the cross-host review: a schema-valid profile
  // arranged in config-family order wrote `written: true` with disk bytes that differed
  // from its own canonical form.
  //
  // Canonicalizing here makes the schema the SINGLE authority for byte order, so
  // PROFILE_SESSION_KEYS governs membership only and cannot drift the file.
  const canonical = canonicalProfile(profile, profileSchema);
  const written = await writeMachineProfile({
    homeDir: ctx.homeDir,
    repoRoot: ctx.cwd,
    name,
    profile: canonical,
    overwrite: opts.overwrite === true,
    // `original` is the RAW READER BUNDLE, not the built profile.
    //
    // It was the built profile, and that made §4.3 guard 1 inert on the ONLY path
    // that writes. `buildMachineProfile` sanitizes permission rules on the way in,
    // so handing its output back as `original` had the scrub inspect the sanitizer's
    // own output — exactly what `assertProfileWritable`'s docstring forbids.
    // Reproduced: a rule carrying `Authorization: Bearer <token>` is rewritten to
    // `Bearer <redacted-token>`, the gate returns ok and the profile is WRITTEN;
    // passing the raw bundle refuses it. A profile the guard exists to refuse was
    // being laundered past it.
    //
    // The READ path (`readProfileFile`) passing the profile itself stays correct and
    // must not be "fixed" to match: a profile that arrived from another machine has
    // no pre-sanitize source, and the docstring names that case explicitly.
    validate: profileWriteGate({ schemaValidate: validateProfile, original: lossyProfileInputs(readers), homeDir: ctx.homeDir }),
    now: ctx.now,
  });
  if (!written?.written) {
    return {
      exitCode: EXIT.INVALID,
      report: {
        verb: 'profile export',
        name,
        status: 'refused',
        reason: written?.reason ?? 'unknown',
        diagnostics: written?.diagnostics ?? ['profile write refused'],
      },
    };
  }
  return {
    exitCode: EXIT.OK,
    report: {
      verb: 'profile export',
      name,
      pointer: written.pointer ?? null,
      hash: profileHash(profile, profileSchema),
      selection,
      status: 'written',
      // Forwarded, not hardcoded empty: writeMachineProfile already merges the
      // family lock's diagnostics into its success result, and a release that
      // could not put back a displaced lock reports through exactly that channel.
      // Dropping it here made that reporting inert — the write succeeded, so the
      // operator saw a clean `written` while a lock name may have been left free
      // (peer round-3 MAJOR).
      //
      // Coverage, stated because it is absent: mutation-measured, re-hardcoding
      // `[]` here fails no test. Producing a failed release through the CLI needs
      // the lock file to change identity DURING the critical section, and `boot()`
      // exposes no seam that reaches inside it. The rule itself is covered where
      // it lives (bootstrap-artifacts' release + wrapper regressions); this one
      // line of wiring is not.
      diagnostics: written.diagnostics ?? [],
    },
  };
}

async function runProfileSeed(ctx, opts) {
  const { validateRun, validateProfile } = await loadContext(ctx);
  const seeded = await readProfileFile(ctx, opts.profile_file);

  const picked = await selectRun({ homeDir: ctx.homeDir, opts, defaultSelector: 'latest-open', validateRun });
  if (picked.error || picked.manifest.status !== 'open') {
    // §3 — seed targets the newest OPEN run; with no open run it exits 30.
    return { exitCode: EXIT.NO_ACTIVE_RUN, report: { verb: 'profile seed', status: 'no-active-run', diagnostics: ['profile seed requires an open run (§3); start one with `runtime:bootstrap plan`.'] } };
  }
  // Every run MUTATOR refuses a future minor, not only resume (Codex review
  // MAJOR — seed slipped past the gate and updated a document this runtime
  // only half-understands). Recovery verbs (abandon) stay exempt.
  const seedDocSchema = parseRunSchemaMinor(picked.manifest.schema);
  if (seedDocSchema && seedDocSchema.minor > READER_RUN_SCHEMA.minor) {
    return { exitCode: EXIT.INVALID, report: { verb: 'profile seed', status: 'refused', diagnostics: [`Run ${picked.run.run_id} carries schema ${picked.manifest.schema}, newer than this runtime's ${RUN_SCHEMA_VERSION} — seeding would persist a document this runtime only partially understands. Upgrade the runtime plugin (§4.6).`] } };
  }

  // §4.5 — validate exactly, safety-grade before presenting, present every
  // value as a DEFAULT requiring confirmation, never apply one. seedProposals
  // owns the grading; the run records only the seeded_from linkage — defaults
  // pre-fill the interview, they never decide a step (§4.5.4).
  const proposals = seedProposals({ profile: seeded.profile, validate: validateProfile });
  if (proposals?.ok === false) {
    return { exitCode: EXIT.INVALID, report: { verb: 'profile seed', status: 'refused', diagnostics: proposals.refused ?? ['profile failed seed validation'] } };
  }
  // The SAME pass `plan --profile-file` runs. Marking the unanswerable values on
  // one entry point and not the other meant a valid profile carrying, say, an
  // all-kinds `notify_kinds` was offered as a sensible default by this verb and
  // flagged by the other (both review lanes) — the operator confirms it here and
  // meets exit 40 at the answers boundary.
  const seedWarnings = markUnanswerableProposals(proposals);

  const updated = await updateBootstrapRun({
    homeDir: ctx.homeDir,
    repoRoot: ctx.cwd,
    runId: picked.run.run_id,
    now: ctx.now,
    validate: validateRun,
    mutate: (m) => ({ ...m, seeded_from: { profile_id: seeded.profileId, profile_hash: seeded.hash } }),
  });
  if (!updated.updated) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'profile seed', status: 'persist-failed', reason: updated.reason, diagnostics: updated.diagnostics } };
  }
  return {
    exitCode: EXIT.OK,
    report: {
      verb: 'profile seed',
      run_id: picked.run.run_id,
      seeded_from: { profile_id: seeded.profileId, profile_hash: seeded.hash },
      proposals: sanitizeProposals(proposals),
      status: 'seeded',
      warnings: [...seeded.warnings, ...seedWarnings],
      diagnostics: updated.diagnostics,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// D1 — the report-level display bound. The per-artifact cap in
// lib/schema-validate.mjs bounds ONE validation; a single report can still
// aggregate findings from several sources (the manifest's validator warnings,
// the selection divergence, every soft warning a verb accumulated), so the
// budget is spent once more here.
//
// `diagnostics` are spent first because an error the operator must act on
// outranks a warning they may not have to. The marker text is FIXED — it says
// that something was dropped without becoming a second place where a count
// could disagree with `finding_counts`, which is the authority.
export const BOOTSTRAP_REPORT_SCHEMA_VERSION = 'runtime-bootstrap-report-2.0';
export const REPORT_FINDINGS_MAX = 32;
const REPORT_OVERFLOW_MARKER = 'Further findings were omitted from this report; see finding_counts for the totals, and read the run artifact directly for the full set.';

// A report UNDER the cap is returned untouched — not decorated with a
// `findings_omitted: false`. The ordinary report shape is unchanged by this
// bound existing; the extra fields appear only when something was actually
// dropped, which is the only case where a consumer needs them.
export function boundReportFindings(report) {
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : null;
  const warnings = Array.isArray(report?.warnings) ? report.warnings : null;
  if (diagnostics === null && warnings === null) return report;
  const counts = { diagnostics: diagnostics?.length ?? 0, warnings: warnings?.length ?? 0 };
  if (counts.diagnostics + counts.warnings <= REPORT_FINDINGS_MAX) return report;

  const keptDiagnostics = diagnostics ? diagnostics.slice(0, REPORT_FINDINGS_MAX) : null;
  const keptWarnings = warnings ? warnings.slice(0, Math.max(0, REPORT_FINDINGS_MAX - (keptDiagnostics?.length ?? 0))) : null;
  // The marker lands on whichever list survives, so a report that carries only
  // warnings still says out loud that it is incomplete. Silent truncation is the
  // failure this whole bound exists to avoid — a capped list that does not admit
  // it reads as "that was everything".
  const marked = keptDiagnostics ?? keptWarnings;
  marked.push(REPORT_OVERFLOW_MARKER);
  return {
    ...report,
    ...(keptDiagnostics ? { diagnostics: keptDiagnostics } : {}),
    ...(keptWarnings ? { warnings: keptWarnings } : {}),
    finding_counts: counts,
    findings_omitted: true,
  };
}

// Free text reaching a rendered line is single-lined, redacted, and bounded.
// `completion.proofs[].reasons` is schema-bounded by LENGTH ONLY (maxLength
// 512) — a newline or an ESC is schema-valid — and its inputs are not all
// grammar-clamped: a Codex plugin-list version is carried through as whatever
// string the host printed (lib/machine-probe.mjs). Interpolating that raw would
// let a reason fabricate a line that looks like this renderer's own output.
// Same rule the completion-output contract applies to free text.
// The render boundary neutralizes every character that could END A LINE, move a
// terminal cursor, or REORDER the display — and nothing else. Row forgery is the
// threat.
//
// The HISTORICAL path used to be the other half of this justification — it
// replayed a stored, operator-editable completion verbatim — and it no longer
// is. Under the D1 disclosure invariant (§3.2) that path renders from a
// projection whose every field was reconstructed against an enum, an anchored
// pattern, or a count, so it reaches the renderer with no free text at all.
// Neutralizing a clamped value would be theatre; the guarantee there comes from
// the projection, not from this sanitizer.
//
// Deliberately NOT lib/permission-sanitize's `singleLine` + `redactSecrets`
// (both were tried at this boundary and withdrawn):
//   * `singleLine` squeezes runs of whitespace, and an operator-facing path may
//     legitimately contain two spaces;
//   * redaction provably destroys real payloads at this boundary — the
//     plugin-management handoff carries a 64-hex plan hash that the generic
//     32+-hex rule eats whole, a path component can look like an email, and a
//     SemVer build identifier can be long hex. Nothing rendered here is a
//     credential channel: it is runtime-authored text or the operator's own
//     file, and §5's sanitize discipline already keeps secrets out of artifacts.
const RENDER_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u206a-\u206f\u2066-\u2069\ufff9-\ufffb]/g;
function renderSafe(value) {
  // NO trim: `apply_command` and `fragment_pointer` are copy-critical, and a
  // POSIX path may legitimately begin or end with a space. Trimming is applied
  // by renderLine only, whose inputs are prose.
  return String(value ?? '').replace(RENDER_UNSAFE_RE, ' ');
}

// The bounded variant, for text whose LENGTH is not controlled by us:
// `completion.proofs[].reasons` is up to 64 entries of 512 chars, so the joined
// aggregate can reach 32 KiB on one line. Operator-facing guidance (a CONFIG
// step's recovery, an apply command) is judge-authored and finite, so it is
// neutralized but NOT truncated — cutting a runbook mid-sentence would trade one
// dishonesty for another.
const RENDER_LINE_MAX = 400;

// The cut itself, on a real GRAPHEME CLUSTER boundary. A UTF-16 slice lies
// about the text it truncated in two ways, both reachable from a host-printed
// version string:
//   * it can land BETWEEN a surrogate pair, emitting a lone high surrogate that
//     renders as U+FFFD — sanitizing text into mojibake is its own small
//     dishonesty;
//   * it can land INSIDE a cluster, which corrupts nothing visibly and instead
//     silently changes which character was there. Cutting `e` + U+0301 after
//     the `e` renders a confident `e`; cutting a flag after its first regional
//     indicator renders a different flag's letter; cutting `👍🏽` after the base
//     changes its skin tone. The operator cannot tell any of it happened.
//
// This delegates to `Intl.Segmenter`, which IS the Unicode text-segmentation
// standard (UAX #29) rather than an approximation of it. A hand-rolled version
// shipped first and was WRONG on measurement: it backed off over `\p{M}` only,
// so ZWJ sequences (`Cf`), regional-indicator pairs (`So`) and emoji modifiers
// (`Sk`) all still split — none of those are marks — and its "don't retreat to
// empty" guard reproduced the exact stripped-base corruption the helper claims
// to prevent, on `e` followed by a budget's worth of combining marks. Four
// distinct cluster families, one standard segmenter; enumerating categories by
// hand is how the first three were missed.
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
function boundedCut(clean, budget) {
  if (clean.length <= budget) return clean;
  // Walk clusters and keep whole ones while they fit. `budget - 1` leaves room
  // for the ellipsis, matching the pre-existing bound.
  const room = budget - 1;
  let end = 0;
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(clean)) {
    if (index + segment.length > room) break;
    end = index + segment.length;
  }
  // A single cluster wider than the whole budget (a long ZWJ chain, or a base
  // trailed by hundreds of marks) leaves nothing whole to keep. Emitting the
  // bare ellipsis is the honest answer: any prefix of that cluster would be a
  // DIFFERENT character presented as if it were the recorded one, which is the
  // corruption this function exists to refuse.
  return `${clean.slice(0, end)}…`;
}

function renderLine(value) {
  return boundedCut(renderSafe(value).trim(), RENDER_LINE_MAX);
}

// The Stage-8 evidence aggregate, rendered FAIRLY (§8's presentation rule).
//
// `reasons.join('; ')` through a single tail-truncated line was first-come: the
// budget is shared, so one long reason spends all of it and every later reason
// disappears — with no marker saying anything was dropped. Measured on the
// ordinary case, not a contrived one: a full version drift emits 3 scalar keys
// plus 2 hosts × 8 plugins = 19 short reasons (lib/completion-reducer.mjs
// `boundVersionsFresh`), of which the old render showed 9 and silently ate 10.
// A single reason carrying an unbounded SemVer build identifier showed 1 of 4.
//
// The policy, in three parts — the whole point is that none of them is a bigger
// cap:
//   1. ONE REASON PER LINE, each with its OWN bound. Fairness comes from not
//      sharing the budget at all; a long reason can no longer spend a later
//      one's. It also removes a real ambiguity — reasons interpolate
//      host-printed strings, and a `; ` inside one used to look exactly like
//      the separator between two.
//   2. A TOTAL budget bounds the block, so the 64 × 512 the schema permits
//      cannot flood the report. Because each line is bounded independently,
//      at least ⌊TOTAL/PER_LINE⌋ = 4 reasons are visible WHATEVER their
//      lengths. The old guarantee was zero. The budget is charged against
//      reason PAYLOAD only — labels, indents and the marker ride on top, so
//      the emitted block runs a few hundred chars wider than the constant.
//      Stated rather than tightened: the constant exists to keep one proof's
//      evidence from flooding a report, and a fixed per-line overhead does not
//      threaten that (Refine-verify peer, MINOR).
//   3. What did not fit is COUNTED OUT LOUD. Silent truncation reads as "that
//      was everything", which is the failure the whole policy exists to avoid —
//      the same rule `boundReportFindings` already applies one level up.
//
// Per-reason budgeting on one shared line was the other candidate and was
// measured, not argued away: splitting 400 chars across 12 realistic reasons
// leaves 29 each, so every reason is truncated past recognition AND the block
// still fits, so no marker fires. It scored strictly worse than the defect it
// was meant to fix.
const RENDER_REASONS_TOTAL = 1600;

// `label` names BOTH lines this emits: reasons render under `<label>: ` and the
// omission marker under `<label>-omitted: `. The two must not share a label.
// They did, and a reason reading `(+63 further reasons not shown; read the run
// artifact for the full set)` then rendered byte-for-byte like a marker the
// renderer had written, claiming an omission that never happened (Refine-verify
// peer, MAJOR). A reason can still contain that text — it simply arrives under
// `<label>: `, where it is visibly the record's own words rather than the
// renderer's count.
function renderReasonLines(reasons, indent, label) {
  const supplied = Array.isArray(reasons) ? reasons : [];
  // Blank and control-only entries are not rendered — a line reading
  // `evidence: ` says nothing. They are still COUNTED: `maxLength` with no
  // `minLength` makes `""` and `"   "` schema-valid (runtime-bootstrap-run-1.3),
  // so filtering them before the accounting let a record hold two entries, show
  // one, and claim nothing was omitted (Refine-verify peer, MAJOR). The count
  // below is taken against everything the record held, not against what
  // survived the filter.
  const renderable = supplied.map((reason) => renderSafe(reason).trim()).filter(Boolean);
  if (supplied.length === 0) return [];
  const shown = [];
  let spent = 0;
  for (const reason of renderable) {
    const piece = boundedCut(reason, RENDER_LINE_MAX);
    // The first reason is always shown, whatever it costs: a block that
    // rendered only the marker would report a count and no evidence at all.
    if (shown.length > 0 && spent + piece.length > RENDER_REASONS_TOTAL) break;
    shown.push(`${indent}${label}: ${piece}`);
    spent += piece.length;
  }
  const omitted = supplied.length - shown.length;
  if (omitted > 0) {
    const blanks = supplied.length - renderable.length;
    shown.push(`${indent}${label}-omitted: +${omitted} further entr${omitted === 1 ? 'y' : 'ies'} not shown${blanks > 0 ? ` (${blanks} blank)` : ''}; read the run artifact for the full set`);
  }
  return shown;
}

// D1 §3.2 — a JSON.parse SyntaxError message embeds a snippet of the INPUT, and
// carries no `code` to short-circuit on. Only the numeric position is
// extracted: it is a number, it locates the fault for an operator opening the
// file, and it cannot carry the bytes it points at.
//
// The pattern is ANCHORED to the parser's own trailing phrase, not matched
// loosely. V8 emits two message families and only one carries a position:
//
//   `Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)`
//   `Unexpected token 'p', "position 9"... is not valid JSON`
//
// A loose /position (\d+)/ matched the SECOND family too — inside the quoted
// snippet of the input — so a file whose own text began `position 987654321`
// reported a position it forged for itself. Requiring the ` in JSON at
// position N` phrasing at END OF MESSAGE cannot be reached from a quoted
// snippet, because that family always ends `is not valid JSON`.
//
// And it is NOT a byte offset: the parser counts UTF-16 code units, so a
// document containing `é` reports a position one short of its byte offset.
// Naming the coordinate system is cheaper than converting, and honest.
function jsonParsePosition(err) {
  const at = / in JSON at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(err?.message ?? '');
  return at ? ` (at input position ${at[1]}, in JSON-parser coordinates)` : '';
}

// §3.2's fallback for a value that is not grammar-clamped: its TYPE, its
// LENGTH, or its ORDINAL — never its content. An array reports its element
// count AND its total width, because "8 rules" and "8 rules totalling 6 KiB"
// are different things to confirm.
function describeWithheld(value) {
  if (value === null || value === undefined) return '<unset>';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const width = value.reduce((n, item) => n + String(item ?? '').length, 0);
    return `<${value.length} entr${value.length === 1 ? 'y' : 'ies'}, ${width} chars — withheld per §3.2>`;
  }
  return `<string, ${String(value).length} chars — withheld per §3.2>`;
}

export function renderText(report) {
  const lines = [];
  lines.push(`runtime:bootstrap ${report.verb}`);
  if (report.run_id) lines.push(`- run: ${report.run_id}${report.run_status ? ` (${report.run_status})` : ''}`);
  if (report.historical) {
    lines.push(`- HISTORICAL: legacy schema ${report.legacy_schema} — stored record summarized, free text withheld; nothing re-probed or re-certified (ADR-0048 §1)`);
  }
  if (report.status && !report.completion) lines.push(`- status: ${report.status}`);
  // A refusal's machine-readable `reason` used to reach `--format json` only.
  // `profile export` and `abandon` both set it, and both pair it with
  // `diagnostics` that can be empty — leaving a text-mode operator with
  // "refused" and no cause at all.
  if (report.reason) lines.push(`- reason: ${renderSafe(report.reason)}`);
  if (report.selection) lines.push(`- selection: bundle=${report.selection.bundle}; desired=${report.selection.desired.join(',')}`);
  // §3 — `profile export` computed a POINTER (where the profile landed, the one
  // thing the operator needs to use it) and a hash, and rendered neither.
  if (report.verb === 'profile export' && report.status === 'written') {
    if (report.name) lines.push(`- profile: ${renderSafe(report.name)}`);
    if (report.pointer) lines.push(`- pointer: ${renderSafe(report.pointer)}`);
    if (report.hash) lines.push(`- hash: ${renderSafe(report.hash)}`);
  }
  // §4.5 items 3 and 4 are PRESENTATION obligations — "present every remaining
  // value as a default requiring confirmation" and "the profile's value is shown
  // as a labelled note". The script graded both correctly and then dropped the
  // whole result on the floor, so the skill's own statement that unsafe source
  // values "arrive as labelled notes" was true of the computation and false of
  // anything the operator could see.
  if (report.seeded_from) {
    lines.push(`- seeded from: ${renderSafe(report.seeded_from.profile_id)} (${renderSafe(report.seeded_from.profile_hash)})`);
  }
  if (report.proposals) {
    const { proposals = [], notes = [], refused = [] } = report.proposals;
    for (const entry of refused) lines.push(`  ! refused: ${renderLine(entry)}`);
    // §3.2 governs whether a value's CONTENT may cross artifact → report. The
    // profile's own schema is maxLength-only for `scalarField.value` and
    // `ruleArray.items`, so the PROFILE cannot answer the question — but this
    // runtime's config validators can, per key, and that is now the rule.
    //
    // BOTH HALVES ARE REPAIRED, at report-BUILD time (`sanitizeProposals`). The
    // history is worth keeping because each stage misled the next: an early
    // version printed values verbatim in text AND `--format json`; the text half
    // was repaired with `describeWithheld`; a comment then claimed the leak was
    // closed, which it was not, because `--format json` serializes the report
    // OBJECT and the renderer never touches it. Sanitizing the object is what
    // finally closes it, and it closes `plan --profile-file` at the same time
    // (cross-host review, MAJOR — that verb would otherwise have extended the
    // open door rather than inherited a shut one).
    //
    // The rule is PER-FIELD, which is the thing the previous comment correctly
    // said was missing: a config key with a closed-set validator is
    // grammar-clamped, so its value is disclosable — the 1.2 session scalars and
    // the notify enums included. A key with no validator, and every rule array,
    // still leaves as the §3.2 fallback: TYPE and LENGTH. So the operator now
    // reads the values that are safe to read and learns the shape of the rest,
    // rather than the shape of everything.
    //
    // `value_disclosed` records which of the two happened, so a machine consumer
    // does not have to infer it from the string.
    //
    // This leaves a REAL tension the owner should settle rather than the
    // renderer: §4.5 item 4 says to present every remaining value as a default
    // requiring confirmation, and a withheld value is not presented in the
    // fullest sense of that sentence. §3.2 wins here only because it is the
    // conservative side — echoing content that the disclosure rule forbids is
    // not reversible once it is in a log.
    for (const proposal of proposals) {
      // `user-scope-only` rides the line because the marker exists to be acted on:
      // an operator confirming `session.entry_brief` has to know it may never be
      // written repo-side (ADR-0045 §7), and until this it reached `--format json`
      // only — the text operator saw a scope of `machine` and nothing else (code
      // review, MEDIUM). It is a boolean this runtime derives, so §3.2 does not
      // withhold it: no content of the profile crosses.
      const scopeBits = [
        proposal.scope ? `scope ${renderSafe(proposal.scope)}` : null,
        proposal.user_scope_only === true ? 'user-scope-only — never write this repo-side' : null,
      ].filter(Boolean);
      // `value` was sanitized at BUILD time (sanitizeProposals), so it is
      // already either a grammar-clamped token or a withheld descriptor —
      // re-describing it here would turn a legal enum back into
      // "<string, 13 chars>" and lose the per-field disclosure the object now
      // carries. `renderSafe` still applies: safe-to-disclose is not the same
      // question as safe-to-render.
      lines.push(`  - default (confirm): ${renderSafe(proposal.key)} = ${renderSafe(proposal.value)}${scopeBits.length > 0 ? ` [${scopeBits.join('; ')}]` : ''}`);
    }
    for (const note of notes) {
      lines.push(`  ! ${renderSafe(note.labelled)}: ${renderSafe(note.key)} — ${renderLine(note.note)}`);
    }
    if (proposals.length === 0 && notes.length === 0 && refused.length === 0) {
      lines.push('  - the profile proposed no defaults for this machine');
    }
  }
  if (report.completion) {
    // `delivery-attested` is a DERIVED presentation label (ADR-0048 §3):
    // provider ack currently passing + owner receipt currently attested. It
    // decorates the state line — the generic completion state itself is never
    // redefined by receipt.
    const ackPassed = (report.completion.proofs ?? []).some((p) => p.kind === 'egress-provider-ack' && p.status === 'passed');
    const deliveryAttested = ackPassed && report.completion.egress_receipt_attestation?.status === 'attested';
    lines.push(`- completion: ${report.completion.state}${deliveryAttested ? ' (delivery-attested)' : ''}${report.completion.unsatisfied.length ? `; unsatisfied=${report.completion.unsatisfied.join(',')}` : ''}${report.completion.missing_steps.length ? `; missing=${report.completion.missing_steps.join(',')}` : ''}`);
    // Stage 8 renders ONCE, here, from the reducer — the sole evidence
    // authority (§8). `steps[]` carries the orthogonal CONTROL axis (is
    // execution reachable; did the operator choose), and the two genuinely
    // disagree: a proof can be `passed` AND `declined`, or `stale` AND
    // `blocked`. Printing both as peer rows is what let a live-fire operator
    // read a passed egress send as a failure — the control row says `pending`
    // whatever the evidence says, because proof judgement never sees evidence.
    const stepById = new Map((report.steps ?? [])
      .filter((step) => typeof step?.id === 'string')
      .map((step) => [step.id, step]));
    // Exactly one row per proof KIND. The reducer already rejects duplicate
    // evidence rather than choosing between records (§8), but the schema does
    // not make `proofs[]` unique by kind — so a stored duplicate would print two
    // identical-looking rows here and invite the operator to believe whichever
    // they read first. Report the conflict instead of silently picking one.
    // (The historical path applies the same rule inside projectLegacyCompletion,
    // so its de-duplication holds in `--format json` too, not only on this line.)
    const kindCounts = new Map();
    for (const proof of report.completion.proofs ?? []) {
      kindCounts.set(proof.kind, (kindCounts.get(proof.kind) ?? 0) + 1);
    }
    const renderedKinds = new Set();
    for (const proof of report.completion.proofs ?? []) {
      // Required proofs always show. A NON-required one shows only when the
      // operator declined it: `applyAnswers` accepts a decline against a proof
      // this selection does not apply, and that choice used to reach the
      // operator through the generic loop. Filtering on `required` alone would
      // silently drop a recorded decision.
      if (!proof.required && !proof.declined) continue;
      // The row is labelled from the KIND, not from the record's own
      // `step_id`. The schema validates the two independently and a historical
      // terminal run is replayed without re-reduction, so a hand-edited record
      // could otherwise label deep-peer evidence as the egress proof. The kind
      // is what the evidence is ABOUT; a step_id that disagrees with it is not
      // trusted to join either (fail closed to evidence-only).
      const canonicalId = `proof.${proof.kind}`;
      if (renderedKinds.has(canonicalId)) continue;
      renderedKinds.add(canonicalId);
      if ((kindCounts.get(proof.kind) ?? 0) > 1) {
        lines.push(`  - [stage 8] ${canonicalId}: ${kindCounts.get(proof.kind)} conflicting evidence records — none shown; duplicate evidence is rejected, not chosen between (§8)`);
        continue;
      }
      lines.push(`  - [stage 8] ${canonicalId}: ${proof.status}${proof.declined ? ' (declined)' : ''}`);
      lines.push(...renderReasonLines(proof.reasons, '      ', 'evidence'));
      const control = proof.step_id === canonicalId ? stepById.get(canonicalId) : null;
      // `blocked` is the one control state the evidence row cannot already
      // convey and the operator can act on. `declined` rides the row above,
      // and `pending` is exactly the string that caused the original misread.
      if (control?.status === 'blocked' && control.recovery) {
        lines.push(`      execution: ${renderLine(control.recovery)}`);
      }
    }
    // §8.2's Codex /hooks attestation is the THIRD reason array on this object
    // and had no row at all — not truncated, absent. The live path rendered
    // only proof and receipt reasons, so a stale attestation reached the
    // operator as nothing whatsoever while the legacy summary path below has
    // reported its `reason_count` all along (Refine-verify peer, MAJOR).
    //
    // Enumerating the sites that READ `.reasons` is what missed it, and the
    // reason is structural: a grep for readers finds every place a field is
    // truncated and no place a field has no reader. The mirror of a
    // shows-too-little bug is sometimes a shows-nothing one.
    if (report.completion.hook_attestation) {
      const attestation = report.completion.hook_attestation;
      lines.push(`  - hook attestation: ${attestation.status}`);
      lines.push(...renderReasonLines(attestation.reasons, '      ', 'reason'));
    }
    if (report.completion.egress_receipt_attestation) {
      const receipt = report.completion.egress_receipt_attestation;
      // The MIRROR of the Stage-8 aggregate, and the reason this row moved with
      // it. It reached the operator through `reasons[0]` alone — a different
      // mechanism from the truncated join above, the identical dishonesty: the
      // row looks complete, and reasons[1..n] are gone with nothing saying so.
      // Fixing only the site the follow-up named would have left the same
      // failure shipped one line below it.
      //
      // The prefix is a LABEL, not an indent, and that is load-bearing. Giving
      // these reasons their own line is what makes their leading characters
      // start a line at all — under the old inline form they never could — so a
      // bare `      ` prefix would let a reason reading `evidence: …` render as
      // a perfect Stage-8 evidence row belonging to a proof. Verified by
      // rendering exactly that string. Every line this renderer emits begins
      // with a label the renderer wrote.
      lines.push(`  - receipt attestation: ${receipt.status}`);
      lines.push(...renderReasonLines(receipt.reasons, '      ', 'reason'));
    }
  }
  // D1 — the historical path renders from the SAME projected object the JSON
  // format serializes, so the two cannot diverge in the field set. Nothing below
  // passes through renderSafe/renderLine, and that is deliberate rather than an
  // omission: every value here was reconstructed against an enum, an anchored
  // pattern, or is a count, so there is no free text left for a control
  // character to arrive in. The sanitizer guards free strings; this path no
  // longer has any.
  if (report.legacy_completion_summary) {
    const summary = report.legacy_completion_summary;
    const counts = [
      summary.unsatisfied_count ? `unsatisfied=${summary.unsatisfied_count}` : '',
      summary.missing_steps_count ? `missing=${summary.missing_steps_count}` : '',
    ].filter(Boolean).join('; ');
    lines.push(`- stored completion (summary; free text withheld): ${summary.state ?? 'unreadable'}${counts ? `; ${counts}` : ''}`);
    for (const proof of summary.proofs ?? []) {
      if (proof.conflicting_records) {
        lines.push(`  - [stage 8] proof.${proof.kind}: ${proof.conflicting_records} conflicting evidence records — none shown; duplicate evidence is rejected, not chosen between (§8)`);
        continue;
      }
      lines.push(`  - [stage 8] proof.${proof.kind}: ${proof.status ?? 'unreadable'}${proof.declined ? ' (declined)' : ''}${proof.reason_count ? `; ${proof.reason_count} reason(s) withheld` : ''}`);
    }
    if (summary.unreadable_proof_records > 0) {
      lines.push(`  - ${summary.unreadable_proof_records} proof record(s) carried no recognizable kind and are not shown`);
    }
    for (const [label, verdict] of [['hook attestation', summary.hook_attestation], ['receipt attestation', summary.egress_receipt_attestation]]) {
      if (!verdict) continue;
      lines.push(`  - ${label}: ${verdict.status ?? 'unreadable'}${verdict.reason_count ? `; ${verdict.reason_count} reason(s) withheld` : ''}`);
    }
    if (summary.source?.artifact_pointer) {
      lines.push(`  - full record: ${summary.source.artifact_pointer} (json pointer ${summary.source.json_pointer})`);
    }
  }
  if (report.stage0 && Object.keys(report.stage0).length > 0) {
    lines.push('- Stage 0 (manual, host-native — §2):');
    for (const [host, entry] of Object.entries(report.stage0)) {
      lines.push(`  - ${host}: ${renderSafe(entry.reason)}`);
      for (const command of entry.commands) lines.push(`      ${renderSafe(command)}`);
    }
  }
  if (report.plugin_management) {
    lines.push(`- plugin management (presented, never executed here — §1.6):`);
    for (const action of report.plugin_management.actions) lines.push(`  - ${action.host}: ${renderSafe(action.command)}${action.note ? ` (${renderSafe(action.note)})` : ''}`);
    lines.push(`  - run: ${renderSafe(report.plugin_management.presented_command)}`);
  }
  // §3.3 — the STANDING VALUE DECISIONS, rendered as their own block.
  //
  // The step loop below skips `satisfied` rows, so a value step that succeeded —
  // including the `unset` posture, whose whole point is that the config carries
  // nothing — would otherwise disappear from text entirely: the operator's
  // decision would be invisible in exactly the state where it worked.
  //
  // Reconstructed CANONICALLY from the fold, never copied from
  // `choices[].answer`. The raw answer is a maxLength-only string (§3.2: a field
  // the grammar does not clamp is not disclosable), while every value here has
  // passed a closed-set validator, so what is printed is this runtime's own
  // vocabulary rather than operator input echoed back.
  for (const row of report.value_decisions ?? []) {
    lines.push(`- [stage 4] ${row.step_id}: ${row.mode}${row.decisions ? ` — ${Object.entries(row.decisions).map(([k, v]) => `${k}=${renderSafe(v)}`).join(' ')}` : ''}`);
  }
  for (const step of report.steps ?? []) {
    if (['satisfied', 'not-applicable'].includes(step.status)) continue;
    // Stage 8 was presented once above, joined to its evidence verdict (§8).
    // This loop is the CONFIG (Stage 1-7) unresolved-step presentation.
    if (PROOF_STAGES.includes(step.stage)) continue;
    // Every free-text field is sanitized, not only the Stage-8 ones: a CONFIG
    // step's `observed` and `recovery` interpolate the probe's plugin version,
    // which lib/machine-probe.mjs carries through as whatever string the host
    // printed. An unsanitized one forges a row exactly as a proof reason would.
    lines.push(`- [stage ${step.stage}] ${step.id}: ${step.status}${step.observed ? ` (observed: ${renderSafe(step.observed)})` : ''}`);
    // Belt-and-braces with the decline-time field withdrawal: a refused
    // key's historical hand-off is never rendered (Refine-verify round 5).
    if (step.apply_command && step.status !== 'declined') lines.push(`    apply: ${renderSafe(step.apply_command)}`);
    if (step.fragment_pointer && step.status !== 'declined') lines.push(`    fragment: ${renderSafe(step.fragment_pointer)}`);
    if (step.recovery) lines.push(`    ${renderSafe(step.recovery)}`);
  }
  for (const warning of report.warnings ?? []) lines.push(`! ${renderSafe(warning)}`);
  for (const diagnostic of report.diagnostics ?? []) lines.push(`  ${renderSafe(diagnostic)}`);
  return `${lines.join('\n')}\n`;
}

function usage() {
  return `Usage: bootstrap.mjs <verb> [flags]   (machine-bootstrap-contract.md §3)
  plan     [--bundle <id>] [--plugins <csv>] [--profile-file <path>] [--answers <path>] [--format text|json]
  status   [--run-id <id> | --latest | --latest-open] [--format text|json]
  resume   [--run-id <id> | --latest-open] [--answers <path>] [--format text|json]
  verify   [--run-id <id> | --latest] [--format text|json]
  attest   [--run-id <id> | --latest] [--format text|json]   (ADR-0048 §3 — record the owner phone-receipt attestation for a recorded egress-provider-ack; the one post-terminal append)
  abandon  (--run-id <id> | --latest-open) [--reason <text>]
  profile export [--name <id>] [--from-run <id>] [--overwrite] [--format text|json]
  profile seed   --profile-file <path> [--run-id <id> | --latest-open] [--format text|json]
Exit codes (§3.1): 0 complete; 10 configured-not-verified; 20 incomplete; 30 no-active-run; 40 invalid input; 50 legacy-historical (terminal run under an older schema minor — stored record shown, nothing re-certified); 1 unexpected error.
`;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const VERB_RUNNERS = Object.freeze({
  plan: runPlan,
  status: runStatus,
  resume: runResume,
  verify: runVerify,
  attest: runAttest,
  abandon: runAbandon,
  'profile export': runProfileExport,
  'profile seed': runProfileSeed,
});

/**
 * The programmatic surface (tests inject everything; main() supplies process
 * defaults). Returns { exitCode, report, rendered }.
 */
export async function runBootstrap({
  argv,
  env = process.env,
  homeDir = homedir(),
  cwd = process.cwd(),
  hostname = osHostname(),
  now = Date.now(),
  runner = defaultRunner,
  subprocessRunner = defaultSubprocessRunner,
  pluginRoot = resolve(SCRIPT_DIR, '..'),
} = {}) {
  let opts;
  try {
    opts = parseBootstrapArgs(argv ?? []);
  } catch (err) {
    if (err instanceof UsageError) {
      // The message interpolates the OFFENDING ARGUMENT, so it is neutralized
      // on the same terms as every other rendered line (§3): an argv value
      // carrying a newline could otherwise forge a row above the usage block.
      // The JSON `error` keeps the raw text — a JSON string escapes control
      // characters, so there is no row to forge there.
      return { exitCode: err.exitCode, report: { error: err.message }, rendered: `✗ ${renderSafe(err.message)}\n${usage()}` };
    }
    throw err;
  }
  if (opts.verb === 'help') {
    return { exitCode: EXIT.OK, report: { usage: usage() }, rendered: usage() };
  }

  // §10.2 — the machine-global home fails closed when $HOME is the repository;
  // resolved once here so every verb shares the verdict.
  const home = await resolveMachineArtifactHome({ homeDir, repoRoot: cwd });
  if (!home.ok) {
    return { exitCode: EXIT.INVALID, report: { error: home.diagnostic }, rendered: `✗ ${renderSafe(home.diagnostic)}\n` };
  }

  const ctx = { env, homeDir, cwd, hostname, now, runner, subprocessRunner, pluginRoot };
  try {
    const { exitCode, report: raw } = await VERB_RUNNERS[opts.verb](ctx, opts);
    // ONE projection, built BEFORE the format branch. Both renderings consume
    // the same object, so text and `--format json` cannot disagree about which
    // findings a report carries (D1).
    const report = boundReportFindings(raw);
    const rendered = opts.format === 'json'
      ? `${JSON.stringify({ schema: BOOTSTRAP_REPORT_SCHEMA_VERSION, verb: opts.verb, runtime_version: RUNTIME_VERSION, ...report }, null, 2)}\n`
      : renderText(report);
    return { exitCode, report, rendered };
  } catch (err) {
    if (err instanceof UsageError) {
      return { exitCode: err.exitCode, report: { error: err.message }, rendered: `✗ ${renderSafe(err.message)}\n` };
    }
    throw err;
  }
}

async function main() {
  const { exitCode, rendered } = await runBootstrap({ argv: process.argv.slice(2) });
  process.stdout.write(rendered);
  process.exit(exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`runtime:bootstrap failed: ${err.stack ?? err.message}\n`);
    process.exit(EXIT.UNEXPECTED);
  });
}
