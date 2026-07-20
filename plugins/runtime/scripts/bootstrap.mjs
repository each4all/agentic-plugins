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
  BOOTSTRAP_TERMINAL_RUN_STATUSES,
  abandonBootstrapRun,
  createBootstrapRun,
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
  hardClosureViolations,
  loadPluginSet,
  resolveBundle,
  validatePluginSet,
} from './lib/plugin-set.mjs';
import { deriveExpectedSteps, stepIds, validateStepGraph } from './lib/step-registry.mjs';
import {
  currentBoundVersions,
  importHookAttestation,
  importProofMetadata,
  invalidateStaleSteps,
  recomputeHookAttestation,
  reduceCompletion,
} from './lib/completion-reducer.mjs';
import { buildMachineProfile, profileHash, profileWriteGate, seedProposals } from './lib/machine-profile.mjs';
import {
  readUserGlobalClaudePermission,
  readUserGlobalCodexPermission,
  readUserGlobalEgress,
  readUserGlobalModelEffort,
  readUserGlobalNotify,
} from './lib/profile-readers.mjs';
import { loadSchema, makeValidator } from './lib/schema-validate.mjs';
import { gatherCodexNotificationInputs, buildCodexNotificationPlanSection, makeNotificationRunId } from './lib/notification-plan.mjs';
import { gatherEgressLauncherInputs, buildEgressLauncherPlanSection, makeEgressLauncherRunId } from './lib/egress-launcher-plan.mjs';
import { gatherPermissionPlanInputs, buildPermissionPlanSection } from './lib/permission-plan.mjs';
import { makePermissionRunId } from './lib/permission-artifacts.mjs';

export { RUNTIME_VERSION };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUN_SCHEMA_VERSION = 'runtime-bootstrap-run-1.1';

// §3.1 — the exit-code contract. These are the ONLY codes this command exits
// with; a verb maps its completion state through EXIT_BY_STATE below.
export const EXIT = Object.freeze({
  COMPLETE: 0,
  OK: 0,
  CONFIGURED_NOT_VERIFIED: 10,
  INCOMPLETE: 20,
  NO_ACTIVE_RUN: 30,
  INVALID: 40,
  UNEXPECTED: 1,
});

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
    throw new UsageError(`unknown verb '${verb}' (expected: plan | status | resume | verify | abandon | profile export | profile seed)`);
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
export function judgeSteps({ expected, probe, raw, pluginSet, readers, hookVerdict, previousById = new Map(), now }) {
  const observedAt = new Date(now).toISOString();
  const judged = new Map();
  const floors = Object.fromEntries(
    Object.entries(pluginSet.plugins).map(([name, entry]) => [name, entry.minimum_version ?? null]),
  );

  const observeStatus = (step) => {
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
    if (id === stepIds.egressConfigured()) {
      const channel = readers?.egress?.channel ?? null;
      return channel != null
        ? { status: 'satisfied', observed: `channel=${channel}` }
        : { status: 'pending' };
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
    const observed = observeStatus(step);
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
      fragment_pointer: previous?.fragment_pointer ?? null,
      apply_command: observed.apply_command ?? previous?.apply_command ?? null,
      fragment_applied: previous?.fragment_applied === true,
      recovery: observed.recovery ?? null,
    };
    // §5 — fragment_applied marks that THIS run rendered a fragment and a later
    // post-probe observed the operator applying it (never a pre-existing match).
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

export const ANSWER_VALUES = Object.freeze(['decline', 'accept', 'execute']);

/**
 * Apply an answers list to judged steps. An answer whose step_id is not an
 * expected step of the run is REJECTED (exit 40) rather than recorded — a stale
 * answers file cannot smuggle a step into a manifest the registry never derived
 * (§3, §6.1; test #34). An illegal decline (non-declinable step) is rejected on
 * the same grounds (test #12).
 */
export function applyAnswers({ steps, answers, now, selection = null, pluginSet = null }) {
  const at = new Date(now).toISOString();
  const byId = new Map(steps.map((s) => [s.id, s]));
  const choices = [];
  const history = [];
  // Duplicate answers apply in file order — the LAST one wins the step state,
  // while choices[] records every one (the run is replayable from its own
  // manifest, so nothing is silently dropped).
  for (const { step_id: stepId, answer } of answers) {
    const step = byId.get(stepId);
    if (!step) {
      throw new UsageError(`answers file names step '${stepId}', which is not an expected step of this run (§6.1); refusing to record it`);
    }
    if (!ANSWER_VALUES.includes(answer)) {
      throw new UsageError(`answer '${answer}' for ${stepId} is not one of ${ANSWER_VALUES.join('|')}`);
    }
    if (answer === 'decline') {
      if (!step.declinable) {
        throw new UsageError(`step ${stepId} is not declinable (§6.2 — host presence/auth, marketplace registration, runtime, companions, and hard-edge targets are never declinable)`);
      }
      if (step.status !== 'satisfied') {
        history.push({ step_id: stepId, from: step.status, to: 'declined', reason: 'operator declined via answers file', at });
        step.status = 'declined';
      }
    }
    choices.push({ step_id: stepId, answer, at });
  }

  // §6.2 — declining a plugin creates a new effective custom selection and
  // RE-RUNS the hard dependency closure. The registry already refuses declines
  // on hard-edge targets, so this catches the inverse: declining a plugin that
  // something retained still hard-requires (and the mandatory floor).
  if (selection && pluginSet) {
    const declinedPlugins = new Set(
      steps
        .filter((step) => step.status === 'declined')
        .map((step) => step.id.match(/^plugin\.([a-z-]+)\./)?.[1])
        .filter(Boolean),
    );
    if (declinedPlugins.size > 0) {
      const retained = (selection.desired ?? []).filter((name) => !declinedPlugins.has(name));
      const missingMandatory = MANDATORY_PLUGINS.filter((name) => !retained.includes(name));
      if (missingMandatory.length > 0) {
        throw new UsageError(`declining ${[...declinedPlugins].join(', ')} would drop ${missingMandatory.join(', ')} (§6.2 — mandatory in every selection)`);
      }
      const violations = hardClosureViolations(pluginSet, retained);
      if (violations.length > 0) {
        const detail = violations.map((v) => `${v.plugin} hard-requires ${v.requires} on ${v.host}`).join('; ');
        throw new UsageError(`declining ${[...declinedPlugins].join(', ')} breaks the §9.1 hard dependency closure: ${detail}`);
      }
    }
  }
  return { choices, history };
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

function buildPluginActionCandidates({ selection, pluginSet, probe }) {
  const actions = [];
  for (const name of selection.desired) {
    const hosts = pluginSet.plugins[name]?.hosts ?? [];
    for (const host of hosts) {
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
async function composeFragments({ homeDir, cwd, env, runId, now, steps, warnings }) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const persist = async (name, body, stepId, applyCommand, target) => {
    const step = byId.get(stepId);
    if (!step || step.status === 'satisfied' || step.status === 'declined' || step.status === 'not-applicable') return;
    const write = await writeBootstrapFragment({ homeDir, repoRoot: cwd, runId, name, content: `${JSON.stringify(body, null, 2)}\n` });
    if (!write?.ok) {
      warnings.push(`fragment ${name} could not be persisted: ${(write?.diagnostics ?? ['unknown write failure']).join('; ')}`);
      return;
    }
    step.fragment_pointer = write.fragment.pointer;
    step.apply_command = applyCommand;
    step.recovery = guidance103(target);
  };

  // Stage 5 — notification (Codex notify= + tui fragments via the pure builder).
  // Each builder gets a run id in ITS OWN family's grammar — the sections carry
  // their family run-id validators, and a bootstrap-shaped id fails them.
  try {
    const gathered = await gatherCodexNotificationInputs({ homeDir, env });
    const { section } = buildCodexNotificationPlanSection({ gathered, now: new Date(now), runId: makeNotificationRunId(now) });
    await persist('notification-plan', section, stepIds.notifyConfigured(),
      'Merge the rendered notify fragment into $CODEX_HOME/config.toml (see the fragment body), then resume.',
      '$CODEX_HOME/config.toml');
  } catch (err) {
    warnings.push(`notification plan could not be built: ${err?.message ?? String(err)}`);
  }

  // Stage 5 — egress launcher (ADR-0041 §12 state-aware runbook via the pure builder).
  try {
    const gathered = await gatherEgressLauncherInputs({ repoRoot: cwd, homeDir, env });
    const { section } = buildEgressLauncherPlanSection({ gathered, host: 'claude', now: new Date(now), runId: makeEgressLauncherRunId(now) });
    await persist('egress-launcher-plan', section, stepIds.egressConfigured(),
      'Follow the rendered per-machine activation runbook (config.local.toml block + launcher env); the credential is never written by tooling.',
      '~/.agentic-plugins/config.local.toml');
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

async function selectRun({ homeDir, opts, defaultSelector }) {
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
  return { run, manifest };
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
    env: ctx.env,
    runner: ctx.runner,
    // NEUTRAL cwd — never the caller's repository (§1.1).
    cwd: tmpdir(),
  });
  const probe = serializeProbe({ raw, runtimeVersion: RUNTIME_VERSION, now: ctx.now });
  return { raw, probe };
}

async function readUserGlobalReaders(ctx) {
  const [modelEffort, notify, claudePermission, codexPermission] = await Promise.all([
    readUserGlobalModelEffort({ homeDir: ctx.homeDir }),
    readUserGlobalNotify({ homeDir: ctx.homeDir }),
    readUserGlobalClaudePermission({ homeDir: ctx.homeDir }),
    readUserGlobalCodexPermission({ homeDir: ctx.homeDir, env: ctx.env }),
  ]);
  const egress = readUserGlobalEgress({ repoRoot: ctx.cwd, homeDir: ctx.homeDir, env: ctx.env });
  return { modelEffort, notify, claudePermission, codexPermission, egress };
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

function hookVerdictFor({ manifest, pluginSet, selection, probe }) {
  const codexHookPlugins = selection.desired.filter((n) => pluginSet.plugins[n]?.hook_bearing?.codex === true).sort();
  const applicable = codexHookPlugins.length > 0;
  return recomputeHookAttestation(manifest?.completion?.hook_attestation ?? null, {
    current: currentBoundVersions({ probe, selection: { plugins: selection.desired }, runtimeVersion: RUNTIME_VERSION }),
    expectedPlugins: codexHookPlugins,
    probe,
    applicable,
  });
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
  if (opts.profile_file) {
    const seeded = await readProfileFile(ctx, opts.profile_file);
    seededSelection = seeded.profile.selection;
    seededFrom = { profile_id: seeded.profileId, profile_hash: seeded.hash };
  }

  const { selection, softWarnings } = resolveSelection({ opts, pluginSet, seededSelection });
  const { raw, probe } = await probeNow(ctx);
  const readers = await readUserGlobalReaders(ctx);

  const expected = deriveExpectedSteps({ pluginSet, selection: { plugins: selection.desired } });
  const graph = validateStepGraph(expected);
  if (!graph.ok) throw new Error(`step registry produced an invalid graph (runtime bug): ${graph.errors.join('; ')}`);

  const hookVerdict = hookVerdictFor({ manifest: null, pluginSet, selection, probe });
  const steps = judgeSteps({ expected, probe, raw, pluginSet, readers, hookVerdict, now: ctx.now });

  const answers = opts.answers ? await readAnswersFile(opts.answers) : [];
  const { choices, history } = applyAnswers({ steps, answers, now: ctx.now, selection, pluginSet });

  const warnings = [...softWarnings];
  const stage0 = buildStage0(probe, raw);
  const candidates = buildPluginActionCandidates({ selection, pluginSet, probe });
  const planHash = candidates.length > 0
    ? await fetchSettingsPlanHash({ subprocessRunner: ctx.subprocessRunner, cwd: ctx.cwd, env: ctx.env })
    : { hash: null, status: 'not-needed', reason: 'no plugin-management actions are needed' };

  const completion = reduceCompletion({ pluginSet, selection: { plugins: selection.desired }, steps, proofs: [], hookAttestation: null, probe, runtimeVersion: RUNTIME_VERSION });
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
  await composeFragments({ homeDir: ctx.homeDir, cwd: ctx.cwd, env: ctx.env, runId: created.run_id, now: ctx.now, steps, warnings });
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

async function reprobeAgainstRun(ctx, manifest, pluginSet) {
  const { raw, probe } = await probeNow(ctx);
  const readers = await readUserGlobalReaders(ctx);
  const selection = manifest.selection;
  const expected = deriveExpectedSteps({
    pluginSet,
    selection: { plugins: selection.desired },
    permissionFragmentApplied: Object.fromEntries(['claude', 'codex'].map((h) => [
      h,
      (manifest.steps ?? []).find((s) => s.id === stepIds.permissionApplied(h))?.fragment_applied === true,
    ])),
  });
  const hookVerdict = hookVerdictFor({ manifest, pluginSet, selection, probe });

  // §7 — recorded step state is invalidated (reset to pending, stamped) when
  // runtime / either host CLI / any selected plugin version moved since the
  // recorded probe. Computed here for every verb; PERSISTED only by resume.
  const current = currentBoundVersions({ probe, selection: { plugins: selection.desired }, runtimeVersion: RUNTIME_VERSION });
  const invalidation = invalidateStaleSteps({
    steps: manifest.steps ?? [],
    probe: manifest.probe ?? null,
    current,
    selection: { plugins: selection.desired },
    at: new Date(ctx.now).toISOString(),
  });
  const priorForJudge = new Map(invalidation.steps.map((s) => [s.id, s]));

  const steps = judgeSteps({ expected, probe, raw, pluginSet, readers, hookVerdict, previousById: priorForJudge, now: ctx.now });
  const completion = reduceCompletion({
    pluginSet,
    selection: { plugins: selection.desired },
    steps,
    proofs: manifest.completion?.proofs ?? [],
    hookAttestation: manifest.completion?.hook_attestation ?? null,
    probe,
    runtimeVersion: RUNTIME_VERSION,
  });
  return { raw, probe, readers, steps, completion, selection, invalidation };
}

async function runStatus(ctx, opts) {
  const { pluginSet } = await loadContext(ctx);
  const picked = await selectRun({ homeDir: ctx.homeDir, opts, defaultSelector: 'latest' });
  if (picked.error) {
    return { exitCode: picked.exitCode, report: { verb: 'status', status: 'no-active-run', diagnostics: [picked.error === 'no-active-run' ? 'No bootstrap run exists; status never synthesizes one (§3). Start with `runtime:bootstrap plan`.' : picked.error] } };
  }
  // R0 — re-probe, re-judge IN MEMORY, report. Nothing below writes (test #33).
  const { probe, steps, completion } = await reprobeAgainstRun(ctx, picked.manifest, pluginSet);
  const report = {
    verb: 'status',
    run_id: picked.run.run_id,
    run_status: picked.manifest.status,
    selection: picked.manifest.selection,
    completion,
    steps,
    probe,
    diagnostics: [],
  };
  return { exitCode: EXIT_BY_STATE[completion.state] ?? EXIT.UNEXPECTED, report };
}

async function runVerify(ctx, opts) {
  const { pluginSet } = await loadContext(ctx);
  const picked = await selectRun({ homeDir: ctx.homeDir, opts, defaultSelector: 'latest' });
  if (picked.error) {
    return { exitCode: picked.exitCode, report: { verb: 'verify', status: 'no-active-run', diagnostics: [picked.error === 'no-active-run' ? 'No bootstrap run exists; verify never synthesizes one (§3).' : picked.error] } };
  }
  // §3 errata — verify does not RUN proofs; it re-judges the RECORDED ones
  // against the current probe's bound versions and reports. An absent required
  // proof is reported `absent` (the reducer caps at configured-not-verified →
  // exit 10); it is never manufactured here (test #33's negative half).
  const { probe, steps, completion } = await reprobeAgainstRun(ctx, picked.manifest, pluginSet);
  const report = {
    verb: 'verify',
    run_id: picked.run.run_id,
    run_status: picked.manifest.status,
    selection: picked.manifest.selection,
    completion,
    proofs: completion.proofs,
    hook_attestation: completion.hook_attestation,
    steps,
    probe,
    diagnostics: [],
  };
  return { exitCode: EXIT_BY_STATE[completion.state] ?? EXIT.UNEXPECTED, report };
}

const PROOF_EXECUTE_FLAGS = Object.freeze({
  'deep-peer-smoke': ['--deep-peer-smoke', '--execute-deep-peer-smoke'],
  'workflow-continuation': ['--workflow-continuation-proof', '--execute-workflow-continuation-proof'],
  permission: ['--permission-proof', '--execute-permission-proof'],
});

const DOCTOR_SECTION_BY_KIND = Object.freeze({
  'deep-peer-smoke': 'deep_peer_smoke',
  'workflow-continuation': 'workflow_continuation_proof',
  permission: 'permission_proof',
});

function mapDoctorDirectionStatus(direction) {
  if (!direction || direction.execution === 'not_executed') return 'absent';
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
async function executeProofViaDoctor(ctx, { kind, probe, selection }) {
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
  const bound = currentBoundVersions({ probe, selection: { plugins: selection.desired }, runtimeVersion: RUNTIME_VERSION });
  const imported = importProofMetadata({
    kind,
    status: 'passed', // provenance only — the reducer recomputes from directions
    directions: {
      'claude->codex': { status: mapDoctorDirectionStatus(section?.directions?.claude_to_codex), ran_at: ranAt },
      'codex->claude': { status: mapDoctorDirectionStatus(section?.directions?.codex_to_claude), ran_at: ranAt },
    },
    artifact_pointer: report?.doctor_artifact?.artifact_pointer ?? null,
    artifact_hash: null,
    bound_versions: bound,
    ran_at: ranAt,
  });
  if (!imported.ok) return { ok: false, diagnostic: `proof metadata for ${kind} did not import: ${imported.errors.join('; ')}`, record: null };
  return { ok: true, diagnostic: null, record: imported.record, doctorReport: report };
}

async function runResume(ctx, opts) {
  const { pluginSet, validateRun } = await loadContext(ctx);
  const picked = await selectRun({ homeDir: ctx.homeDir, opts, defaultSelector: 'latest-open' });
  if (picked.error) {
    return { exitCode: picked.exitCode, report: { verb: 'resume', status: 'no-active-run', diagnostics: [picked.error === 'no-active-run' ? 'No open bootstrap run to resume (§3). Start with `runtime:bootstrap plan`.' : picked.error] } };
  }
  if (BOOTSTRAP_TERMINAL_RUN_STATUSES.includes(picked.manifest.status)) {
    return { exitCode: EXIT.NO_ACTIVE_RUN, report: { verb: 'resume', status: 'no-active-run', diagnostics: [`Run ${picked.run.run_id} is already ${picked.manifest.status}; resume operates on open runs only.`] } };
  }

  const reprobe = await reprobeAgainstRun(ctx, picked.manifest, pluginSet);
  const { probe, steps, selection } = reprobe;
  const warnings = [];

  const answers = opts.answers ? await readAnswersFile(opts.answers) : [];
  const { choices, history } = applyAnswers({ steps, answers, now: ctx.now, selection, pluginSet });

  // Stage 8 — execute the proofs the operator explicitly approved (answer
  // `execute` on a proof step), through doctor's explicit executor flags.
  const proofs = [...(picked.manifest.completion?.proofs ?? [])].filter((p) => p && typeof p === 'object' && typeof p.kind === 'string' && p.bound_versions);
  let hookAttestation = picked.manifest.completion?.hook_attestation?.status === 'attested' ? picked.manifest.completion.hook_attestation : null;
  const executeKinds = answers.filter((a) => a.answer === 'execute' && a.step_id.startsWith('proof.')).map((a) => a.step_id.replace(/^proof\./, ''));
  let doctorReport = null;
  for (const kind of executeKinds) {
    const result = await executeProofViaDoctor(ctx, { kind, probe, selection });
    if (!result.ok) {
      warnings.push(result.diagnostic);
      continue;
    }
    doctorReport = result.doctorReport ?? doctorReport;
    const idx = proofs.findIndex((p) => p.kind === kind);
    if (idx >= 0) proofs[idx] = result.record;
    else proofs.push(result.record);
    const persisted = await writeBootstrapProof({ homeDir: ctx.homeDir, repoRoot: ctx.cwd, runId: picked.run.run_id, kind, record: result.record });
    if (!persisted?.ok) warnings.push(`proof metadata for ${kind} could not be persisted: ${(persisted?.diagnostics ?? ['unknown write failure']).join('; ')}`);
  }

  // The Codex /hooks attestation rides the same verb the same way (§8.2): a
  // doctor report fetched for a proof already carries codex_hook_review; when
  // none was fetched but the attestation step is still open, a read-only doctor
  // run would be R0-adjacent — resume is M1, so fetching one is in-contract.
  const codexHookPlugins = selection.desired.filter((n) => pluginSet.plugins[n]?.hook_bearing?.codex === true).sort();
  if (codexHookPlugins.length > 0 && !hookAttestation) {
    if (!doctorReport) {
      const doctorPath = join(SCRIPT_DIR, 'doctor.mjs');
      const result = await ctx.subprocessRunner(doctorPath, ['--repo-root', ctx.cwd, '--format', 'json'], { cwd: ctx.cwd, env: ctx.env, timeoutMs: 120_000 });
      if (result?.ok) {
        try { doctorReport = JSON.parse(result.stdout); } catch { warnings.push('doctor output for the hook attestation was not valid JSON'); }
      }
    }
    if (doctorReport?.codex_hook_review) {
      const imported = importHookAttestation(doctorReport.codex_hook_review, { expectedPlugins: codexHookPlugins });
      if (imported.ok) {
        hookAttestation = imported.record;
        const persisted = await writeBootstrapProof({ homeDir: ctx.homeDir, repoRoot: ctx.cwd, runId: picked.run.run_id, kind: 'hook-attestation', record: imported.record });
        if (!persisted?.ok) warnings.push(`hook attestation metadata could not be persisted: ${(persisted?.diagnostics ?? ['unknown write failure']).join('; ')}`);
      } else {
        warnings.push(`the recorded Codex /hooks attestation is not importable for this selection: ${imported.errors.join('; ')}`);
      }
    }
  }

  const completion = reduceCompletion({
    pluginSet,
    selection: { plugins: selection.desired },
    steps,
    proofs,
    hookAttestation,
    probe,
    runtimeVersion: RUNTIME_VERSION,
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
  const updated = await updateBootstrapRun({
    homeDir: ctx.homeDir,
    repoRoot: ctx.cwd,
    runId: picked.run.run_id,
    now: ctx.now,
    validate: validateRun,
    mutate: (m) => ({
      ...m,
      status: nextStatus,
      probe,
      steps,
      choices: [...(Array.isArray(m.choices) ? m.choices : []), ...choices],
      history: [...(Array.isArray(m.history) ? m.history : []), ...history],
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

async function runAbandon(ctx, opts) {
  let runId = opts.run_id ?? null;
  if (!runId) {
    const picked = await selectRun({ homeDir: ctx.homeDir, opts: { latest_open: true }, defaultSelector: 'latest-open' });
    if (picked.error) {
      return { exitCode: EXIT.NO_ACTIVE_RUN, report: { verb: 'abandon', status: 'no-active-run', diagnostics: ['No open bootstrap run to abandon.'] } };
    }
    runId = picked.run.run_id;
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
  return { profile, hash: profileHash(profile, profileSchema), profileId: basenameNoExt(path) };
}

function basenameNoExt(path) {
  const base = String(path).split(/[\\/]/).pop() ?? '';
  return base.replace(/\.json$/i, '');
}

async function runProfileExport(ctx, opts) {
  const { pluginSet, validateProfile, profileSchema } = await loadContext(ctx);
  const name = opts.name ?? 'default';
  validateProfileName(name);

  let selection;
  let probe;
  if (opts.from_run) {
    const picked = await selectRun({ homeDir: ctx.homeDir, opts: { run_id: opts.from_run }, defaultSelector: 'run-id' });
    if (picked.error) {
      return { exitCode: picked.exitCode, report: { verb: 'profile export', status: 'no-such-run', diagnostics: [picked.error] } };
    }
    selection = picked.manifest.selection;
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

  const picked = await selectRun({ homeDir: ctx.homeDir, opts, defaultSelector: 'latest-open' });
  if (picked.error || picked.manifest.status !== 'open') {
    // §3 — seed targets the newest OPEN run; with no open run it exits 30.
    return { exitCode: EXIT.NO_ACTIVE_RUN, report: { verb: 'profile seed', status: 'no-active-run', diagnostics: ['profile seed requires an open run (§3); start one with `runtime:bootstrap plan`.'] } };
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
      diagnostics: updated.diagnostics,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderText(report) {
  const lines = [];
  lines.push(`runtime:bootstrap ${report.verb}`);
  if (report.run_id) lines.push(`- run: ${report.run_id}${report.run_status ? ` (${report.run_status})` : ''}`);
  if (report.status && !report.completion) lines.push(`- status: ${report.status}`);
  if (report.selection) lines.push(`- selection: bundle=${report.selection.bundle}; desired=${report.selection.desired.join(',')}`);
  if (report.completion) {
    lines.push(`- completion: ${report.completion.state}${report.completion.unsatisfied.length ? `; unsatisfied=${report.completion.unsatisfied.join(',')}` : ''}${report.completion.missing_steps.length ? `; missing=${report.completion.missing_steps.join(',')}` : ''}`);
    for (const proof of report.completion.proofs ?? []) {
      if (proof.required) lines.push(`  - proof ${proof.kind}: ${proof.status}${proof.declined ? ' (declined)' : ''}`);
    }
  }
  if (report.stage0 && Object.keys(report.stage0).length > 0) {
    lines.push('- Stage 0 (manual, host-native — §2):');
    for (const [host, entry] of Object.entries(report.stage0)) {
      lines.push(`  - ${host}: ${entry.reason}`);
      for (const command of entry.commands) lines.push(`      ${command}`);
    }
  }
  if (report.plugin_management) {
    lines.push(`- plugin management (presented, never executed here — §1.6):`);
    for (const action of report.plugin_management.actions) lines.push(`  - ${action.host}: ${action.command}${action.note ? ` (${action.note})` : ''}`);
    lines.push(`  - run: ${report.plugin_management.presented_command}`);
  }
  for (const step of report.steps ?? []) {
    if (['satisfied', 'not-applicable'].includes(step.status)) continue;
    lines.push(`- [stage ${step.stage}] ${step.id}: ${step.status}${step.observed ? ` (observed: ${step.observed})` : ''}`);
    if (step.apply_command) lines.push(`    apply: ${step.apply_command}`);
    if (step.fragment_pointer) lines.push(`    fragment: ${step.fragment_pointer}`);
    if (step.recovery) lines.push(`    ${step.recovery}`);
  }
  for (const warning of report.warnings ?? []) lines.push(`! ${warning}`);
  for (const diagnostic of report.diagnostics ?? []) lines.push(`  ${diagnostic}`);
  return `${lines.join('\n')}\n`;
}

function usage() {
  return `Usage: bootstrap.mjs <verb> [flags]   (machine-bootstrap-contract.md §3)
  plan     [--bundle <id>] [--plugins <csv>] [--profile-file <path>] [--answers <path>] [--format text|json]
  status   [--run-id <id> | --latest | --latest-open] [--format text|json]
  resume   [--run-id <id> | --latest-open] [--answers <path>] [--format text|json]
  verify   [--run-id <id> | --latest] [--format text|json]
  abandon  (--run-id <id> | --latest-open) [--reason <text>]
  profile export [--name <id>] [--from-run <id>] [--overwrite]
  profile seed   --profile-file <path> [--run-id <id> | --latest-open]
Exit codes (§3.1): 0 complete; 10 configured-not-verified; 20 incomplete; 30 no-active-run; 40 invalid input; 1 unexpected error.
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
      return { exitCode: err.exitCode, report: { error: err.message }, rendered: `✗ ${err.message}\n${usage()}` };
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
    return { exitCode: EXIT.INVALID, report: { error: home.diagnostic }, rendered: `✗ ${home.diagnostic}\n` };
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
      return { exitCode: err.exitCode, report: { error: err.message }, rendered: `✗ ${err.message}\n` };
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
