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
import { RUNTIME_VERSION } from './version.mjs';
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
import { PROOF_STAGES, deriveExpectedSteps, stepIds, validateStepGraph } from './lib/step-registry.mjs';
import {
  currentBoundVersions,
  egressProofOptedIn,
  importHookAttestation,
  importProofMetadata,
  invalidateStaleSteps,
  recomputeHookAttestation,
  reduceCompletion,
} from './lib/completion-reducer.mjs';
import { EGRESS_CREDENTIAL_ENV_VAR, buildMachineProfile, profileHash, profileWriteGate, seedProposals } from './lib/machine-profile.mjs';
import {
  projectClaudePermission,
  projectClaudeStatusline,
  readUserGlobalClaudeSettings,
  resolveClaudeConfigDir,
  readUserGlobalCodexPermission,
  readUserGlobalEgress,
  readUserGlobalModelEffort,
  readUserGlobalNotify,
} from './lib/profile-readers.mjs';
// The named E1 activation checker (ADR-0048 §4): egress.configured is judged
// from ACTIVATION semantics — channel + recipient + credential PRESENCE — not
// the credential-independent §4.4 export shape. Only loadEgressActivation may
// inspect the credential (for presence/collision, in-process); the value never
// reaches this module. EGRESS_ENV_KEYS is imported for the recovery TEXT (the
// key NAME as a placeholder procedure), never for an env read here.
import { EGRESS_ENV_KEYS, loadEgressActivation } from './lib/egress-config.mjs';
import { loadSchema, makeValidator } from './lib/schema-validate.mjs';
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
// schema minor is immutable historical evidence — status/verify present its
// stored completion verbatim and re-certify nothing, so exit 0 (which implies
// a CURRENT completion) would overclaim. The distinct code says exactly
// "historical record shown, nothing re-proven".
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
  'profile export': ['--name', '--from-run', '--overwrite'],
  'profile seed': ['--profile-file', '--run-id', '--latest-open'],
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
// Prerelease-aware semver floors (§13): SemVer §11 identifier ranking
// (1.0.0-alpha < 1.0.0-beta; numeric identifiers compare as JS numbers —
// lossy only above 2^53, far beyond real release ids), which the shared
// semverCompare deliberately omits — its prerelease tie-break ranks a
// release above its own prereleases but never identifiers against each other
// ---------------------------------------------------------------------------

export function comparePrereleaseAware(a, b) {
  const parse = (v) => {
    const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  // Equal cores: a prerelease sorts BELOW its release (SemVer §11).
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const as = pa.pre.split('.');
  const bs = pb.pre.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

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

export function judgeSteps({ expected, probe, raw, pluginSet, readers, hookVerdict, previousById = new Map(), now }) {
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
      const keys = readers?.modelEffort?.keys ?? {};
      const set = Object.values(keys).some((entry) => entry?.value != null);
      return set
        ? { status: 'satisfied', observed: Object.entries(keys).filter(([, v]) => v?.value != null).map(([k, v]) => `${k}=${v.value}`).join(' ') }
        : { status: 'pending', apply_command: 'runtime:settings --apply --target user (model/effort defaults; agentic-plugins-owned config)' };
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
      return { status: 'satisfied', observed: `notify argv matches the canonical receiver wiring (argv[${wiring.argv.length}])` };
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
    throw new UsageError(`--answers file is not valid JSON: ${err.message}`);
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
export function applyAnswers({ steps, answers, now, selection = null, pluginSet = null, verb = 'resume' }) {
  const at = new Date(now).toISOString();
  const byId = new Map(steps.map((s) => [s.id, s]));
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
  for (const { step_id: stepId, answer } of answers) {
    const step = byId.get(stepId);
    if (!step) {
      throw new UsageError(`answers file names step '${stepId}', which is not an expected step of this run (§6.1); refusing to record it`);
    }
    if (!ANSWER_VALUES.includes(answer)) {
      throw new UsageError(`answer '${answer}' for ${stepId} is not one of ${ANSWER_VALUES.join('|')}`);
    }
    if (answer === 'attest-receipt') {
      if (stepId !== stepIds.proofEgressProviderAck()) {
        throw new UsageError(`answer 'attest-receipt' targets ${stepIds.proofEgressProviderAck()} only — receipt testimony about any other step is not a thing this contract records`);
      }
      if (verb === 'plan') {
        throw new UsageError(`answer 'attest-receipt' is not accepted under plan — no provider ack can exist yet, so there is nothing to testify about; use resume or attest`);
      }
    }
    if (answer === 'decline' && !step.declinable) {
      throw new UsageError(`step ${stepId} is not declinable (§6.2 — host presence/auth, marketplace registration, runtime, companions, and hard-edge targets are never declinable)`);
    }
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
async function composeFragments({ homeDir, cwd, env, runId, now, steps, warnings, readersForFragments = null }) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const persist = async (name, body, stepId, applyCommand, target, { desired = null } = {}) => {
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
    step.apply_command = applyCommand;
    // The plan-bound expectation (mode binding, Refine-verify peer): when THIS
    // run rendered a fragment, the step's `desired` records exactly what that
    // fragment asks the operator to merge — the exact probe then judges
    // against the PLAN'S expectation, not against every canonical form.
    if (desired !== null) step.desired = desired;
    // COMPOSE with any observation-time recovery instead of replacing it —
    // judgeSteps' egress recovery carries the activation procedure (which
    // env keys, placeholder-only, uid-less note) that must survive fragment
    // persistence alongside the §10.3 backup/verify guidance (Codex review).
    step.recovery = step.recovery ? `${step.recovery} ${guidance103(target)}` : guidance103(target);
  };

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
    return { error: `Run ${run.run_id} has an unreadable manifest (${err?.code ?? err?.message}); close it with \`abandon ${run.run_id}\`.`, exitCode: EXIT.UNEXPECTED };
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
  return { run, manifest, warnings: verdict.warnings ?? [] };
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
  const claudeSettingsSnapshot = await readUserGlobalClaudeSettings({ homeDir: ctx.homeDir, env: ctx.env });
  const [modelEffort, notify, codexPermission] = await Promise.all([
    readUserGlobalModelEffort({ homeDir: ctx.homeDir }),
    readUserGlobalNotify({ homeDir: ctx.homeDir }),
    readUserGlobalCodexPermission({ homeDir: ctx.homeDir, env: ctx.env }),
  ]);
  const claudePermission = projectClaudePermission(claudeSettingsSnapshot);
  const egress = readUserGlobalEgress({ repoRoot: ctx.cwd, homeDir: ctx.homeDir, env: ctx.env });
  // Step judgement needs ACTIVATION semantics (the named E1 checker) alongside
  // the credential-independent export shape above: `egress` feeds the §4.4
  // machine profile (channel/recipient survive a missing per-machine token),
  // while `egressActivation` feeds egress.configured (channel alone must NOT
  // satisfy — the false-pass this split repairs). Two readers, two questions.
  const egressActivation = loadEgressActivation({ repoRoot: ctx.cwd, homeDir: ctx.homeDir, env: ctx.env });
  // ADR-0048 §1 — the Codex-side notify WIRING for notify.codex.configured.
  // Gathered here because judgeSteps is synchronous: the config is read once
  // per probe alongside every other user-global reader, through the same
  // notification-plan gather the Stage-5 fragment builder uses (§1.1 keeps
  // bootstrap off the repo-scoped state-readers seam — test #1). Shape:
  //   readable  — the config file could be read (missing file reads as an
  //               empty config: readable, nothing present);
  //   present   — a top-level `notify =` key exists;
  //   argv      — the parsed string elements, or null when the value is
  //               present but not a parseable string array (fail-safe null
  //               from the TOML scanner — never a guess).
  const codexNotifyGathered = await gatherCodexNotificationInputs({ homeDir: ctx.homeDir, env: ctx.env });
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
  let codexNotify;
  if (codexNotifyRead.ok) {
    const parsed = parseCodexNotifyConfigToml(codexNotifyRead.text);
    codexNotify = { readable: true, present: parsed.notify.present, argv: parsed.notify.values ?? null, expected: codexNotifyExpected };
  } else if (codexNotifyRead.reason === 'ENOENT' || codexNotifyRead.reason === 'ENOTDIR') {
    codexNotify = { readable: true, present: false, argv: null, expected: codexNotifyExpected };
  } else {
    codexNotify = { readable: false, present: false, argv: null, expected: codexNotifyExpected };
  }
  return { modelEffort, notify, claudePermission, codexPermission, egress, egressActivation, codexNotify, statuslineClaude, statuslineCodex };
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

// A parsed JSON value is only usable as a report/record when it is a plain
// object: `null`, `false`, `0`, `""` and arrays all survive JSON.parse and would
// otherwise slip through truthiness checks unremarked.
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
  const { pluginSet, validateRun } = await loadContext(ctx);

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
  const seededWarnings = [];
  if (opts.profile_file) {
    const seeded = await readProfileFile(ctx, opts.profile_file);
    seededSelection = seeded.profile.selection;
    seededFrom = { profile_id: seeded.profileId, profile_hash: seeded.hash };
    seededWarnings.push(...seeded.warnings);
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

  const deriveAndJudge = (effectiveSel, previousSteps = null) => {
    const derived = deriveExpectedSteps({ pluginSet, selection: effectiveSel, egressProofRequested });
    const graph = validateStepGraph(derived);
    if (!graph.ok) throw new Error(`step registry produced an invalid graph (runtime bug): ${graph.errors.join('; ')}`);
    const verdict = hookVerdictFor({ recordedAttestation: null, pluginSet, effective: effectiveSel, probe });
    return judgeSteps({
      expected: derived,
      probe,
      raw,
      pluginSet,
      readers,
      hookVerdict: verdict,
      ...(previousSteps ? { previousById: priorJudgeMapOf(previousSteps) } : {}),
      now: ctx.now,
    });
  };

  let effective = effectiveSelection({ pluginSet, selection, steps: [] });
  let steps = deriveAndJudge(effective);

  const { choices, history } = applyAnswers({ steps, answers, now: ctx.now, selection, pluginSet, verb: 'plan' });

  const warnings = [...softWarnings, ...seededWarnings];

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
  await composeFragments({ homeDir: ctx.homeDir, cwd: ctx.cwd, env: ctx.env, runId: created.run_id, now: ctx.now, steps, warnings, readersForFragments: readers });
  const updated = await updateBootstrapRun({
    homeDir: ctx.homeDir,
    repoRoot: ctx.cwd,
    runId: created.run_id,
    now: ctx.now,
    validate: validateRun,
    mutate: (m) => ({ ...m, steps }),
  });
  if (!updated.updated) warnings.push(`fragment pointers could not be persisted into the manifest: ${updated.diagnostics.join('; ')}`);

  const report = {
    verb: 'plan',
    run_id: created.run_id,
    run_pointer: created.pointer,
    selection,
    completion,
    steps,
    stage0,
    plugin_management: presentPluginManagement({ candidates, planHash }),
    probe,
    warnings,
    diagnostics: created.diagnostics,
  };
  return { exitCode: EXIT_BY_STATE[completion.state] ?? EXIT.UNEXPECTED, report };
}

async function reprobeAgainstRun(ctx, manifest, pluginSet, { egressProofRequested = false } = {}) {
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
  const effective = effectiveSelection({ pluginSet, selection, steps: manifest.steps ?? [] });
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
  const expected = deriveExpectedSteps({
    pluginSet,
    selection: effective,
    permissionFragmentApplied: Object.fromEntries(['claude', 'codex'].map((h) => [
      h,
      (manifest.steps ?? []).find((s) => s.id === stepIds.permissionApplied(h))?.fragment_applied === true,
    ])),
    egressProofRequested: egressOptIn,
  });
  const hookVerdict = hookVerdictFor({ recordedAttestation: recordedHookAttestation, pluginSet, effective, probe });

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

  const steps = judgeSteps({ expected, probe, raw, pluginSet, readers, hookVerdict, previousById: priorForJudge, now: ctx.now });
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
  return { raw, probe, readers, steps, completion, selection, effective, invalidation, proofRecords: proofRead.records, recordedHookAttestation, expected, egressOptIn };
}

/**
 * ADR-0048 §1 — a TERMINAL run under an older schema minor is immutable
 * historical evidence: status/verify present the STORED completion verbatim,
 * re-probe nothing, re-certify nothing (its proof files are not even read —
 * a legacy complete with a corrupt proof file is still the historical record
 * it was). The report carries machine-readable `historical` +
 * `not_recertified` markers and exits LEGACY_HISTORICAL, because exit 0 would
 * claim a current completion nobody re-proved. Returns null when the run is
 * not a legacy terminal one.
 */
function legacyTerminalReport(verb, picked) {
  const doc = parseRunSchemaMinor(picked.manifest.schema);
  if (!doc || doc.minor >= READER_RUN_SCHEMA.minor) return null;
  if (!BOOTSTRAP_TERMINAL_RUN_STATUSES.includes(picked.manifest.status)) return null;
  return {
    exitCode: EXIT.LEGACY_HISTORICAL,
    report: {
      verb,
      run_id: picked.run.run_id,
      run_status: picked.manifest.status,
      legacy_schema: picked.manifest.schema,
      historical: true,
      not_recertified: true,
      selection: picked.manifest.selection,
      completion: picked.manifest.completion ?? null,
      diagnostics: [
        `Run ${picked.run.run_id} is terminal under legacy schema ${picked.manifest.schema} — presented as immutable historical evidence; nothing was re-probed or re-certified against the ${RUN_SCHEMA_VERSION} registry (ADR-0048 §1). Start a fresh \`runtime:bootstrap plan\` for current evidence.`,
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
    probe,
    warnings: [...(picked.warnings ?? []), ...(divergence ? [divergence.warning] : [])],
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
    probe,
    warnings: [...(picked.warnings ?? []), ...(divergence ? [divergence.warning] : [])],
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
  if (!result?.ok) {
    return { ok: false, diagnostic: `runtime:doctor --record for ${kind} failed (${result?.error_code ?? result?.exit_code ?? 'unknown'})`, record: null };
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return { ok: false, diagnostic: `runtime:doctor output for ${kind} was not valid JSON`, record: null };
  }
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
  const warnings = [...(picked.warnings ?? [])];

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
  });

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
      permissionFragmentApplied: Object.fromEntries(['claude', 'codex'].map((h) => [
        h,
        steps.find((s) => s.id === stepIds.permissionApplied(h))?.fragment_applied === true,
      ])),
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
      now: ctx.now,
    });
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
  const executeKinds = [...answeredEffective.entries()]
    .filter(([stepId, answer]) => answer === 'execute' && stepId.startsWith('proof.'))
    .map(([stepId]) => stepId.replace(/^proof\./, ''));
  let doctorReport = null;
  let executedAnything = false;
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
    const result = await executeProofViaDoctor(ctx, { kind, probe, effective });
    if (!result.ok) {
      warnings.push(result.diagnostic);
      // A refused import may still carry a complete doctor report (the egress
      // blocked path records one) — reuse it for the hook attestation below
      // WITHOUT setting executedAnything: a blocked executor sent nothing, so
      // the pre-execution probe/readers still describe the machine.
      if (result.doctorReport) doctorReport = result.doctorReport;
      continue;
    }
    doctorReport = result.doctorReport ?? doctorReport;
    executedAnything = true;
    const persisted = await writeBootstrapProof({ homeDir: ctx.homeDir, repoRoot: ctx.cwd, runId: picked.run.run_id, kind, record: result.record });
    if (!persisted?.ok) {
      // Egress is the ONE side-effecting proof: when its send already completed
      // and only the metadata write failed, the machine-global WAL now fences an
      // automatic re-send, so a bare resume would be BLOCKED. Advise reconcile-
      // then-clear rather than a blind retry — otherwise the proof-persist failure
      // recovery compounds into a duplicate send (follow-ups.md L35 gap 1).
      const retryAdvice = kind === 'egress-provider-ack'
        ? 'the egress send may already have reached the phone; reconcile the phone and delete the recorded egress intent (the WAL fences an automatic re-send) before resuming'
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
      const result = await ctx.subprocessRunner(doctorPath, ['--repo-root', ctx.cwd, '--format', 'json'], { cwd: ctx.cwd, env: scrubbedControlPlaneEnv(ctx.env), timeoutMs: 120_000 });
      if (result?.ok) {
        executedAnything = true;
        // A successful parse that is not an OBJECT is not a report: `null`,
        // `false`, `0` and `""` all parse, and each would slip past every
        // truthiness check below without a word (peer, Low).
        try {
          const parsed = JSON.parse(result.stdout);
          if (isPlainReportObject(parsed)) doctorReport = parsed;
          else warnings.push('doctor output for the hook attestation parsed but is not a report object; the attestation step stays open');
        } catch { warnings.push('doctor output for the hook attestation was not valid JSON'); }
      } else {
        warnings.push(`runtime:doctor could not be run for the Codex /hooks attestation (${result?.error_code ?? result?.exit_code ?? 'unknown failure'}); the attestation step stays open`);
      }
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

  // A proof executor can run for minutes; judging its freshness against the
  // PRE-execution probe would compare a snapshot against itself and could mark
  // drifted evidence current (Codex review MAJOR). When anything executed,
  // re-probe: the final reduction — and the persisted probe — reflect the
  // post-execution machine, so a CLI/plugin that moved mid-proof re-judges the
  // evidence stale instead of complete.
  const finalProbe = executedAnything ? (await probeNow(ctx)).probe : probe;
  // The READERS re-read is the same rule for the ACTIVATION half (Plan-verify
  // peer): the egress ack's freshness equality compares its recorded
  // activation_fingerprint against the CURRENT activation — judged from the
  // pre-execution readers, a just-recorded ack could be marked stale (or a
  // stale one current) when the operator changed channel/recipient mid-proof.
  const finalReaders = executedAnything ? await readUserGlobalReaders(ctx) : reprobe.readers;

  // A hook attestation imported ABOVE was judged into `steps` before it existed
  // (reprobeAgainstRun reads proof/ and judges in one pass, and the import comes
  // after), so the reduction below would pair a fresh `attested` verdict with a
  // still-`pending` step and report the run incomplete — completion needs both.
  // The operator's symptom was that the resume which finally imported the claim
  // still showed the step pending, and only a SECOND resume satisfied it: the
  // same "do the thing you already did" loop #645 is about, one step further on.
  // Re-judge against THIS RESUME'S CURRENT steps, not the pre-answer snapshot.
  // applyAnswers mutates step rows in place — a decline sets `declined` and
  // withdraws the fragment pointer, apply command and desired state — and it has
  // already run by the time the import happens. Re-judging from the pre-answer
  // map (the first cut of this fix) silently discarded those mutations: the
  // operator's decline stayed in `choices` and `history` while the step itself
  // reverted to `pending` with its refused hand-off restored, and because the
  // reducer reads `declined` off the step row rather than the choice ledger, a
  // declined proof could even lose its completion cap. Feeding the post-answer
  // rows through the same normalization is exactly how declines already survive
  // from one resume to the next: judgeSteps re-asserts `declined` from
  // `previous` for a declinable step whose fresh observation is not satisfied.
  // Only the hook verdict is new; it is computed against `finalProbe` — the same
  // probe the reduction uses — so step and completion cannot disagree about it.
  //
  // The hook row is not necessarily the ONLY row that moves, and claiming so
  // would be wrong (peer, round 3): the graph pass runs again over the ANSWERED
  // rows, so a dependent the first pass demoted to `blocked` behind a
  // now-declined predecessor correctly converges to `pending` here — declines
  // count as resolved. That is earlier convergence to the same answer, not a new
  // verdict: both `blocked` and `pending` are unresolved to the reducer, so no
  // run completes on it.
  // (The broader "resume reports a probe it did not reduce against" mismatch for
  // non-hook steps is a separate, pre-existing defect and is deliberately not
  // touched here.)
  if (importedHookAttestation) {
    const refreshedVerdict = hookVerdictFor({ recordedAttestation: importedHookAttestation, pluginSet, effective, probe: finalProbe });
    steps = judgeSteps({
      // `expected` — not `reprobe.expected` — because a decline in THIS resume may
      // already have re-derived it against the narrowed selection.
      expected,
      probe: reprobe.probe,
      raw: reprobe.raw,
      pluginSet,
      readers: reprobe.readers,
      hookVerdict: refreshedVerdict,
      previousById: priorJudgeMapOf(steps),
      now: ctx.now,
    });
    // An imported claim that does not stand for THIS selection leaves the step
    // open on purpose — say why, with the selection-scoped reasons, rather than
    // letting the operator re-attest into the same outcome.
    if (refreshedVerdict.status !== 'attested') {
      warnings.push(`the imported Codex /hooks attestation does not hold for this selection (${refreshedVerdict.status}): ${refreshedVerdict.reasons.join('; ')}`);
    }
  }

  // Reduce from the authoritative bytes: everything the executors persisted is
  // read back — validated, hashed — and ONLY that evidence reaches the reducer.
  const finalRead = await readBootstrapProofRecords({ homeDir: ctx.homeDir, runId: picked.run.run_id });
  if (!finalRead.ok) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'resume', status: 'evidence-unreadable', diagnostics: finalRead.errors } };
  }
  const proofs = finalRead.records.filter((r) => PROOF_KINDS.includes(r.kind)).map((r) => r.record);
  const hookAttestation = finalRead.records.find((r) => r.kind === 'hook-attestation')?.record ?? null;
  const finalReceiptRow = finalRead.records.find((r) => r.kind === 'egress-receipt-attestation') ?? null;
  const finalAckRow = finalRead.records.find((r) => r.kind === 'egress-provider-ack') ?? null;

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
  await composeFragments({ homeDir: ctx.homeDir, cwd: ctx.cwd, env: ctx.env, runId: picked.run.run_id, now: ctx.now, steps, warnings, readersForFragments: reprobe.readers });

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

  const stage0 = buildStage0(probe, reprobe.raw);
  const report = {
    verb: 'resume',
    run_id: picked.run.run_id,
    run_status: nextStatus,
    selection,
    completion,
    steps,
    stage0,
    probe,
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
    return { exitCode: EXIT.INVALID, report: { verb: 'attest', status: 'refused', diagnostics: [`Run ${picked.run.run_id} carries schema ${picked.manifest.schema}, not ${RUN_SCHEMA_VERSION} — attest records 1.2 evidence only. Resume an open legacy run to migrate it first; a terminal legacy run stays immutable history.`] } };
  }

  const reprobe = await reprobeAgainstRun(ctx, picked.manifest, pluginSet);
  if (reprobe.proofReadFailure) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'attest', status: 'evidence-unreadable', diagnostics: reprobe.proofReadFailure } };
  }

  const attest = await recordReceiptAttestation(ctx, {
    runId: picked.run.run_id,
    proofRecords: reprobe.proofRecords,
    ackEvaluated: reprobe.completion.proofs.find((p) => p.kind === 'egress-provider-ack') ?? null,
  });
  if (!attest.ok) {
    return { exitCode: EXIT.INVALID, report: { verb: 'attest', status: 'refused', diagnostics: [attest.diagnostic] } };
  }

  // Re-read and re-reduce so the reported verdict is computed over the exact
  // bytes just persisted — the same authoritative-bytes rule resume follows.
  const finalRead = await readBootstrapProofRecords({ homeDir: ctx.homeDir, runId: picked.run.run_id });
  if (!finalRead.ok) {
    return { exitCode: EXIT.UNEXPECTED, report: { verb: 'attest', status: 'evidence-unreadable', diagnostics: finalRead.errors } };
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
    throw new UsageError(`--profile-file is not valid JSON: ${err.message}`);
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

  const written = await writeMachineProfile({
    homeDir: ctx.homeDir,
    repoRoot: ctx.cwd,
    name,
    profile,
    overwrite: opts.overwrite === true,
    validate: profileWriteGate({ schemaValidate: validateProfile, original: profile, homeDir: ctx.homeDir }),
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
      diagnostics: [],
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
      proposals,
      status: 'seeded',
      warnings: seeded.warnings,
      diagnostics: updated.diagnostics,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Free text reaching a rendered line is single-lined, redacted, and bounded.
// `completion.proofs[].reasons` is schema-bounded by LENGTH ONLY (maxLength
// 512) — a newline or an ESC is schema-valid — and its inputs are not all
// grammar-clamped: a Codex plugin-list version is carried through as whatever
// string the host printed (lib/machine-probe.mjs), and a historical report
// replays a STORED, operator-editable completion verbatim. Interpolating that
// raw would let a reason fabricate a line that looks like this renderer's own
// output. Same rule the completion-output contract applies to free text.
// The render boundary neutralizes every character that could END A LINE, move a
// terminal cursor, or REORDER the display — and nothing else. Row forgery is the
// threat: `completion.proofs[].reasons` is schema-bounded by LENGTH only (a
// newline or an ESC is schema-valid), a CONFIG step's `observed` / `recovery`
// interpolate the probe's plugin version, which lib/machine-probe.mjs carries
// through as whatever string the host printed, and a historical report replays a
// stored, operator-editable completion verbatim.
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
function renderLine(value) {
  const clean = renderSafe(value).trim();
  if (clean.length <= RENDER_LINE_MAX) return clean;
  const cut = clean.slice(0, RENDER_LINE_MAX - 1);
  // A UTF-16 slice can land BETWEEN a surrogate pair, emitting a lone high
  // surrogate that renders as U+FFFD — sanitizing text into mojibake is its own
  // small dishonesty. Drop the orphan rather than half a character.
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

export function renderText(report) {
  const lines = [];
  lines.push(`runtime:bootstrap ${report.verb}`);
  if (report.run_id) lines.push(`- run: ${report.run_id}${report.run_status ? ` (${report.run_status})` : ''}`);
  if (report.historical) {
    lines.push(`- HISTORICAL: legacy schema ${report.legacy_schema} — stored record shown verbatim; nothing re-probed or re-certified (ADR-0048 §1)`);
  }
  if (report.status && !report.completion) lines.push(`- status: ${report.status}`);
  if (report.selection) lines.push(`- selection: bundle=${report.selection.bundle}; desired=${report.selection.desired.join(',')}`);
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
    // evidence rather than choosing between records (§8), but a HISTORICAL
    // completion is replayed verbatim without re-reduction, and the schema does
    // not make `proofs[]` unique by kind — so a stored duplicate would print two
    // identical-looking rows here and invite the operator to believe whichever
    // they read first. Report the conflict instead of silently picking one.
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
      if (proof.reasons?.length) lines.push(`      evidence: ${renderLine(proof.reasons.join('; '))}`);
      const control = proof.step_id === canonicalId ? stepById.get(canonicalId) : null;
      // `blocked` is the one control state the evidence row cannot already
      // convey and the operator can act on. `declined` rides the row above,
      // and `pending` is exactly the string that caused the original misread.
      if (control?.status === 'blocked' && control.recovery) {
        lines.push(`      execution: ${renderLine(control.recovery)}`);
      }
    }
    if (report.completion.egress_receipt_attestation) {
      const receipt = report.completion.egress_receipt_attestation;
      lines.push(`  - receipt attestation: ${receipt.status}${receipt.reasons.length ? ` (${renderLine(receipt.reasons[0])})` : ''}`);
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
  profile export [--name <id>] [--from-run <id>] [--overwrite]
  profile seed   --profile-file <path> [--run-id <id> | --latest-open]
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
    const { exitCode, report } = await VERB_RUNNERS[opts.verb](ctx, opts);
    const rendered = opts.format === 'json'
      ? `${JSON.stringify({ schema: 'runtime-bootstrap-report-1.0', verb: opts.verb, runtime_version: RUNTIME_VERSION, ...report }, null, 2)}\n`
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
