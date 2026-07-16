// plugins/runtime/scripts/lib/egress-launcher-plan.mjs
//
// ADR-0041 §12 — first-class egress launcher.
//
// `runtime:settings --egress-launcher-plan` renders a per-machine egress
// ACTIVATION PLAN as an ARTIFACT ONLY, realizing the ADR-0041 prototype-cutover
// track (§2d Status / §11) as first-class tooling. Structurally it mirrors
// --notification-plan (lib/notification-plan.mjs): render + record ONLY.
//
// WHY ARTIFACT-ONLY IS LOAD-BEARING (not mere consistency)
// -----------------------------------------------------------------------------
// ADR-0041 §2c makes egress activation a value that MUST come from the operator
// environment or a fail-closed-verified ignored-local file — precisely so that
// no tool path and no tracked-config path can ever activate egress. A launcher
// that WROTE the activation (config.local.toml, the token, or the ~/.claude
// prototype hooks) would itself BECOME the egress-activation vector §2c closed.
// So this launcher is a PLANNER: it READS the current state (loadEgressActivation
// + loadEgressHeadlineOptIn + a read-only ~/.claude/settings.json scan) and
// renders the operator's steps, but changes NOTHING. It emits NO network effect
// and writes NO activation, so it stays strictly WITHIN — in fact strictly below
// — the E1 ceiling (a planner, not an egress) and needs no ADR-0035 §4 change.
//
// Applying the plan (creating ~/.agentic-plugins/config.local.toml, exporting
// TELEGRAM_BOT_TOKEN, disabling the personal ~/.claude prototype hooks) is an
// explicit USER action — exactly like the notification plan's receiver install.
//
// THE CREDENTIAL IS NEVER READ. buildEgressLauncherPlan surfaces only
// loadEgressActivation's `credentialPresent` boolean — never the token value.
// As defense-in-depth, a final scrubSecrets() pass over the serialized artifact
// fail-closes the write if any secret-shaped value ever reached it. scrubSecrets
// is imported from egress-channel.mjs, the NETWORK-FREE helper half of the E1
// channel (it performs no network/fs I/O and holds no fetch primitive), so this
// import adds NO fetch surface to the settings module graph (the executor
// global-fetch-gate has nothing to flag here).

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { RUNTIME_VERSION } from '../version.mjs';
import { readTextIfExists } from './state-readers.mjs';
import {
  loadEgressActivation,
  loadEgressHeadlineOptIn,
  EGRESS_ENV_KEYS,
  EGRESS_LOCAL_KEYS,
  EGRESS_HEADLINE_ENV_KEY,
  EGRESS_HEADLINE_LOCAL_KEY,
} from './egress-config.mjs';
import { scrubSecrets, validateTelegramChatId } from './egress-channel.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EGRESS_LAUNCHER_PLAN_SCHEMA_VERSION = 'runtime-egress-launcher-plan-1.0';
export const EGRESS_LAUNCHER_PLAN_LATEST_SCHEMA_VERSION = 'runtime-egress-launcher-plan-latest-1.0';
export const EGRESS_LAUNCHER_PLAN_KIND = 'egress-launcher-plan';

// The on-disk family segment under .agentic-plugins/runs/. MUST be registered in
// lib/state-readers.mjs RUNTIME_ARTIFACT_FAMILIES so the doctor inventory +
// retention reporting covers it (mirrors NOTIFICATION_ARTIFACT_FAMILY).
export const EGRESS_LAUNCHER_ARTIFACT_FAMILY = 'egress-launcher';

// Plan mode = f(activation descriptor × prototype detection). The plan is
// STATE-AWARE: an already-cutover machine gets a no-op verification plan; a
// fresh machine gets the full activation steps.
export const EGRESS_LAUNCHER_PLAN_MODES = Object.freeze([
  'activate', //            egress inactive, nothing configured — full activation steps
  'partial', //             egress inactive but partly configured — only the missing pieces
  'prototype-retire-only', // egress active AND the ~/.claude prototype still fires — retire it (dedupe)
  'already-active', //      egress active, prototype absent — cutover complete here; verify + per-machine note
]);

export const EGRESS_LAUNCHER_PLAN_STATUSES = Object.freeze(['planned', 'blocked']);

export const EGRESS_LAUNCHER_RUN_ID_RE = /^egress-launcher-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

// The personal-prototype receiver being retired: ~/.claude/telegram-notify.mjs
// (ADR-0041 Context — the per-machine curl prototype outside the pipeline). The
// prototype is the Claude personal hook; activation itself is host-neutral.
export const PROTOTYPE_RECEIVER_BASENAME = 'telegram-notify.mjs';
export const PROTOTYPE_SETTINGS_RELPATH = ['.claude', 'settings.json'];

// ---------------------------------------------------------------------------
// Prototype detection — READ-ONLY scan of ~/.claude/settings.json hooks
// ---------------------------------------------------------------------------

function prototypeReceiverPath(homeDir) {
  return join(homeDir, '.claude', PROTOTYPE_RECEIVER_BASENAME);
}

// Does a hook command string reference THIS machine's prototype receiver by its
// exact path? Exact-path match (ADR-0041 §12 / brainstorm D2): the resolved
// ~/.claude/telegram-notify.mjs path (or its ~ / $HOME spellings), NOT a loose
// basename-anywhere heuristic that would misclassify an unrelated same-named
// script (mirrors notification-plan's exact-install-path discipline). The
// command is SCRUBBED before it is ever surfaced, so a hook command that
// happened to embed a secret can never ride into the artifact.
function commandReferencesPrototype(command, homeDir) {
  if (typeof command !== 'string' || command.length === 0) return false;
  const candidates = [
    prototypeReceiverPath(homeDir),
    join('~', '.claude', PROTOTYPE_RECEIVER_BASENAME),
    join('$HOME', '.claude', PROTOTYPE_RECEIVER_BASENAME),
  ];
  for (const cand of candidates) {
    let from = 0;
    for (;;) {
      const idx = command.indexOf(cand, from);
      if (idx === -1) break;
      // A REAL reference is bounded on BOTH sides: the candidate must not be a
      // substring of a longer path. A trailing `[A-Za-z0-9._/-]` extends it into a
      // different file (`.mjs.backup`, `.mjs-wrapper`, `.mjs/child`); a leading one
      // means the candidate is only a SUFFIX of another absolute path
      // (`/tmp/prefix<home>/.claude/telegram-notify.mjs`). Requiring a boundary
      // (start/end-of-string or a non-path char) on each side makes the match truly
      // exact-path (Codex review MINOR + re-review: raw `includes` and after-only
      // checks both false-positived).
      const prevCh = command[idx - 1];
      const nextCh = command[idx + cand.length];
      const prevOk = idx === 0 || !/[A-Za-z0-9._/-]/.test(prevCh);
      const nextOk = nextCh === undefined || !/[A-Za-z0-9._/-]/.test(nextCh);
      if (prevOk && nextOk) return true;
      from = idx + cand.length;
    }
  }
  return false;
}

// Walk the Claude settings.json `hooks` value into flat { event, command }
// records. Canonical Claude shape is an OBJECT keyed by event → array of
// matcher-groups → group.hooks[] → { type, command }. Defensive: tolerate an
// array-valued hooks (observed empty `[]` in the wild) and any missing level
// without throwing.
function flattenClaudeHooks(hooks) {
  const records = [];
  const pushGroup = (event, group) => {
    if (!group || typeof group !== 'object') return;
    const inner = Array.isArray(group.hooks) ? group.hooks : [];
    for (const h of inner) {
      if (h && typeof h === 'object' && typeof h.command === 'string') {
        records.push({ event, command: h.command });
      }
    }
  };
  if (Array.isArray(hooks)) {
    for (const group of hooks) pushGroup('(unkeyed)', group);
  } else if (hooks && typeof hooks === 'object') {
    for (const [event, groups] of Object.entries(hooks)) {
      const list = Array.isArray(groups) ? groups : [groups];
      for (const group of list) pushGroup(event, group);
    }
  }
  return records;
}

// READ-ONLY detection of the personal prototype hooks. Never writes, never
// throws — every failure path (absent/unreadable/unparseable settings.json)
// degrades to "no matches", so the plan simply omits the retire step. Returns a
// SANITIZED descriptor safe to embed in the artifact.
export async function detectPrototypeHooks({ homeDir }) {
  const settingsPath = join(homeDir, ...PROTOTYPE_SETTINGS_RELPATH);
  const scriptPresent = existsSync(prototypeReceiverPath(homeDir));
  const base = {
    scope: 'claude-personal-hook',
    settings_path_pointer: join('~', ...PROTOTYPE_SETTINGS_RELPATH),
    script_file_present: scriptPresent,
    settings_present: false,
    parseable: false,
    matches: [],
    match_count: 0,
  };

  const read = await readTextIfExists(settingsPath);
  if (!read.ok) return base;

  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ...base, settings_present: true, parseable: false };
  }

  const records = flattenClaudeHooks(parsed?.hooks);
  const matches = records
    .filter((r) => commandReferencesPrototype(r.command, homeDir))
    .map((r) => ({
      event: typeof r.event === 'string' ? r.event : '(unkeyed)',
      // Scrub the command before it enters the artifact (defense-in-depth: a
      // hook command is unlikely to embed a secret, but the artifact must never
      // be a leak path regardless of what the operator put in their hooks).
      command_pointer: scrubSecrets(r.command),
    }));

  return {
    ...base,
    settings_present: true,
    parseable: true,
    matches,
    match_count: matches.length,
  };
}

// ---------------------------------------------------------------------------
// Layout renderers (rendered TEXT — the operator applies these; runtime never
// writes any of them)
// ---------------------------------------------------------------------------

// Decide value-vs-placeholder in the rendered block (a display concern, not a
// security gate — the credential is the protected value, never the chat-id).
// Reuse the CANONICAL Telegram recipient validator so a valid `@channelusername`
// recipient is pre-filled too, not only a numeric id (Codex review MINOR: a
// username recipient must not fall back to a placeholder on an active machine).
function looksLikeChatId(value) {
  return validateTelegramChatId(value);
}

// RECOMMENDED layout (brainstorm D5): channel + chat-id live in the verified-
// ignored-local file (persistent per-machine, survives shell config, 0600,
// gitignored); the credential stays env-ONLY (§2c). `chatId` is pre-filled when
// known (already-active machine → copy it to your other machines) else a
// placeholder. NO token appears in this file EVER.
export function renderConfigLocalTomlBlock({ chatId, headlineOn = false } = {}) {
  const chat = looksLikeChatId(chatId) ? chatId : '<YOUR_TELEGRAM_CHAT_ID>';
  const headlineLine = headlineOn
    ? `${EGRESS_HEADLINE_LOCAL_KEY} = true          # opt-in status token (currently ON)`
    : `# ${EGRESS_HEADLINE_LOCAL_KEY} = true        # optional, default OFF — adds the closed-vocabulary status token`;
  return [
    '# ~/.agentic-plugins/config.local.toml   (chmod 600 · gitignored · NEVER committed)',
    `${EGRESS_LOCAL_KEYS.channel} = "telegram"`,
    `${EGRESS_LOCAL_KEYS.recipient} = "${chat}"`,
    headlineLine,
    '',
  ].join('\n');
}

// The env line for the credential — ALWAYS required (the token is env-only under
// both layouts, §2c). The value is a literal PLACEHOLDER; a real token is never
// rendered.
export function renderTokenEnvLine() {
  return `export ${EGRESS_ENV_KEYS.credential}="<your Telegram bot token>"   # §2c: token is env-ONLY, never stored in a file by runtime`;
}

// ALTERNATIVE layout: everything (channel + chat-id + token) via env in your
// shell profile. No config.local.toml. Shown alongside the recommended layout so
// the operator can choose (ADR-0041 §2c honors both env and verified-local for
// channel+recipient; the credential is env-only either way).
export function renderEnvLayoutBlock({ chatId, headlineOn = false } = {}) {
  const chat = looksLikeChatId(chatId) ? chatId : '<YOUR_TELEGRAM_CHAT_ID>';
  const lines = [
    '# shell profile (~/.zshrc, ~/.bashrc, …) — env-all alternative layout:',
    renderTokenEnvLine(),
    `export ${EGRESS_ENV_KEYS.channel}="telegram"`,
    `export ${EGRESS_ENV_KEYS.recipient}="${chat}"`,
  ];
  lines.push(headlineOn
    ? `export ${EGRESS_HEADLINE_ENV_KEY}=true            # opt-in status token (currently ON)`
    : `# export ${EGRESS_HEADLINE_ENV_KEY}=true          # optional, default OFF`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Steps builder — the ordered operator runbook, applicability keyed by mode
// ---------------------------------------------------------------------------

function buildSteps({ mode, activation, prototype, headlineOn }) {
  const chatId = activation.recipient; // present only when active (loadEgressActivation contract)
  const needsActivation = mode === 'activate' || mode === 'partial';
  const needsRetire = prototype.match_count > 0;

  const steps = [];

  // 1. Activate runtime egress (recommended + alternative layouts).
  steps.push({
    id: 'activate-egress',
    title: 'Activate runtime egress on this machine',
    applicable: needsActivation,
    detail: needsActivation
      ? 'Create the verified-ignored-local file and export the credential. Channel + chat-id persist in the file; the token is env-only (§2c).'
      : `Egress is already active here (source: ${activation.source ?? 'n/a'}) — no activation needed.`,
    recommended_layout: {
      kind: 'config-local-toml+env-token',
      config_local_toml_pointer: join('~', '.agentic-plugins', 'config.local.toml'),
      config_local_toml: renderConfigLocalTomlBlock({ chatId, headlineOn }),
      token_env_line: renderTokenEnvLine(),
    },
    alternative_layout: {
      kind: 'env-all',
      env_block: renderEnvLayoutBlock({ chatId, headlineOn }),
    },
  });

  // 2. Retire the personal prototype hooks (dedupe): only meaningful if they
  // still fire. This is the WHOLE point of a state-aware plan — on a machine
  // whose prototype hooks are already gone we emit no misleading "disable" step.
  steps.push({
    id: 'retire-prototype',
    title: 'Retire the personal curl prototype (avoid duplicate sends)',
    applicable: needsRetire,
    detail: needsRetire
      ? `Remove the ${prototype.match_count} prototype hook entr${prototype.match_count === 1 ? 'y' : 'ies'} below from ${prototype.settings_path_pointer} so egress is not sent twice (runtime + prototype). This is a manual edit — runtime never writes your host settings.`
      : (prototype.settings_present
        ? `No prototype hooks reference ${prototypeReceiverPath('~')} in ${prototype.settings_path_pointer} — nothing to retire.`
        : `No ${prototype.settings_path_pointer} found — nothing to retire.`),
    hooks_to_remove: prototype.matches,
    script_file_present: prototype.script_file_present,
    script_file_note: prototype.script_file_present
      ? `The prototype script ${join('~', '.claude', PROTOTYPE_RECEIVER_BASENAME)} still exists; you may delete it once no hook references it (optional).`
      : null,
  });

  // 3. Verify — trigger one attention event and confirm exactly one egress.
  steps.push({
    id: 'verify',
    title: 'Verify: trigger an attention event and confirm exactly ONE delivery',
    applicable: true,
    detail: 'Trigger a notification (e.g. an approval prompt or a workflow Stop) and confirm your device receives exactly one message — one from runtime egress, none from the retired prototype. `runtime:dashboard` Tier 2 shows the egress attempt-mirror (dispatched/failed).',
  });

  // 4. Rollback — re-enable the prototype hooks if egress misbehaves.
  steps.push({
    id: 'rollback',
    title: 'Rollback (if needed)',
    applicable: needsRetire,
    detail: 'If runtime egress misbehaves, re-add the prototype hook entries you removed in step 2 (and/or unset the activation env/config) to fall back to the personal prototype. No data is lost — the prototype script is untouched by runtime.',
  });

  // 5. Per-machine repeat — the cutover is per-machine (ADR-0041 §8).
  steps.push({
    id: 'per-machine',
    title: 'Repeat on every machine',
    applicable: true,
    detail: 'ADR-0041 §8: each machine activates independently with the SAME chat-id (env or verified-local) and its OWN token in env. All machines × all sessions fan in to the one Telegram chat; hostname + session_hint keep them distinct. Run this planner on each machine.',
  });

  return steps;
}

// ---------------------------------------------------------------------------
// Mode computation
// ---------------------------------------------------------------------------

export function computeEgressLauncherMode({ activation, prototype }) {
  const protoActive = prototype.match_count > 0;
  if (activation.active) {
    return protoActive ? 'prototype-retire-only' : 'already-active';
  }
  // Inactive: distinguish "partly configured" (the operator has started — one of
  // channel / credential / recipient is present, or a fixable misconfig reason)
  // from a fresh machine (nothing set).
  const startedReasons = new Set([
    'missing-credential',
    'missing-recipient',
    'unknown-egress-channel',
    'credential-collision',
  ]);
  return startedReasons.has(activation.reason) ? 'partial' : 'activate';
}

// ---------------------------------------------------------------------------
// Artifact (settings-artifact shape: per-run dir + latest.json singleton)
// ---------------------------------------------------------------------------

export function makeEgressLauncherRunId(now) {
  const d = now instanceof Date ? now : new Date(now);
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `egress-launcher-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function isValidEgressLauncherRunId(runId) {
  return typeof runId === 'string' && EGRESS_LAUNCHER_RUN_ID_RE.test(runId);
}

export function validateEgressLauncherRunId(runId) {
  if (!isValidEgressLauncherRunId(runId)) {
    throw new Error(
      `invalid egress-launcher run id '${runId}' (expected egress-launcher-YYYYMMDDTHHMMSSZ-<6hex>)`,
    );
  }
  return runId;
}

export function egressLauncherRunRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', 'runs', EGRESS_LAUNCHER_ARTIFACT_FAMILY);
}

export function egressLauncherRunDir(repoRoot, runId) {
  return resolve(egressLauncherRunRoot(repoRoot), validateEgressLauncherRunId(runId));
}

export function egressLauncherArtifactFile(repoRoot, runId) {
  return resolve(egressLauncherRunDir(repoRoot, runId), 'plan.json');
}

export function egressLauncherLatestFile(repoRoot) {
  return resolve(egressLauncherRunRoot(repoRoot), 'latest.json');
}

function pointer(repoRoot, path) {
  const rel = relative(repoRoot, path).split(sep).join('/');
  return rel || basename(path);
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

const ARTIFACT_KEYS = new Set([
  'schema_version', 'runtime_version', 'kind', 'run_id', 'surface', 'status',
  'created_at', 'repo_root_pointer', 'host', 'mode', 'activation_state',
  'prototype', 'steps', 'limits', 'boundary',
]);
// The boundary invariant: every flag MUST be false. The validator refuses to
// write an artifact whose boundary claims any write — a mechanical guard that a
// future edit cannot silently turn the planner into a writer (mirrors
// notification-plan's writes_host_config/installs_receiver invariant).
const BOUNDARY_KEYS = new Set([
  'writes_host_config', 'writes_activation', 'writes_credential', 'installs_anything',
]);
const VALID_HOSTS = new Set(['claude', 'codex']);

function onlyKnownKeys(obj, allowed) {
  return Boolean(obj) && typeof obj === 'object' && Object.keys(obj).every((k) => allowed.has(k));
}

export function isValidEgressLauncherPlanArtifact(artifact) {
  if (!onlyKnownKeys(artifact, ARTIFACT_KEYS)) return false;
  if (artifact.schema_version !== EGRESS_LAUNCHER_PLAN_SCHEMA_VERSION) return false;
  if (artifact.kind !== EGRESS_LAUNCHER_PLAN_KIND) return false;
  if (!isValidEgressLauncherRunId(artifact.run_id)) return false;
  if (artifact.surface !== 'settings') return false;
  if (!EGRESS_LAUNCHER_PLAN_STATUSES.includes(artifact.status)) return false;
  if (typeof artifact.created_at !== 'string' || !artifact.created_at) return false;
  if (artifact.repo_root_pointer !== '.') return false;
  if (!VALID_HOSTS.has(artifact.host)) return false;
  if (!EGRESS_LAUNCHER_PLAN_MODES.includes(artifact.mode)) return false;
  if (!artifact.activation_state || typeof artifact.activation_state !== 'object') return false;
  if (!artifact.prototype || typeof artifact.prototype !== 'object') return false;
  if (!Array.isArray(artifact.steps)) return false;
  if (!Array.isArray(artifact.limits) || !artifact.limits.every((l) => typeof l === 'string')) return false;
  if (!onlyKnownKeys(artifact.boundary, BOUNDARY_KEYS)) return false;
  if (artifact.boundary.writes_host_config !== false) return false;
  if (artifact.boundary.writes_activation !== false) return false;
  if (artifact.boundary.writes_credential !== false) return false;
  if (artifact.boundary.installs_anything !== false) return false;
  return true;
}

// Defense-in-depth leak gate: a secret-shaped value in the SERIALIZED artifact
// fail-closes the write. The primary guarantee is upstream (the credential is
// never read; only credentialPresent is surfaced), so in practice this pass has
// nothing to remove — but it means no future edit can turn the artifact into a
// leak path without tripping this guard. A legitimate chat-id (bare digits) and
// workflow/run ids do not match any scrubSecrets rule.
function assertNoSecretInArtifact(artifact) {
  const serialized = JSON.stringify(artifact);
  if (scrubSecrets(serialized) !== serialized) {
    throw new Error(
      'egress-launcher plan artifact contains a secret-shaped value (refusing to write — see ADR-0041 §2b/§5)',
    );
  }
}

export async function writeEgressLauncherPlanArtifact({ repoRoot, artifact }) {
  if (!isValidEgressLauncherPlanArtifact(artifact)) {
    throw new Error(
      'writeEgressLauncherPlanArtifact: artifact failed validation (refusing to write a malformed or boundary-violating egress-launcher plan)',
    );
  }
  assertNoSecretInArtifact(artifact);
  const runId = artifact.run_id;
  const reportPath = egressLauncherArtifactFile(repoRoot, runId);
  await writeJsonAtomic(reportPath, artifact);
  await writeJsonAtomic(egressLauncherLatestFile(repoRoot), {
    schema_version: EGRESS_LAUNCHER_PLAN_LATEST_SCHEMA_VERSION,
    kind: EGRESS_LAUNCHER_PLAN_KIND,
    run_id: runId,
    surface: artifact.surface,
    status: artifact.status,
    host: artifact.host,
    mode: artifact.mode,
    updated_at: artifact.created_at,
    report_pointer: pointer(repoRoot, reportPath),
    run_pointer: pointer(repoRoot, dirname(reportPath)),
  });
  return {
    run_id: runId,
    family: EGRESS_LAUNCHER_ARTIFACT_FAMILY,
    run_pointer: pointer(repoRoot, egressLauncherRunDir(repoRoot, runId)),
    report_pointer: pointer(repoRoot, reportPath),
    latest_pointer: pointer(repoRoot, egressLauncherLatestFile(repoRoot)),
  };
}

// ---------------------------------------------------------------------------
// The plan builder (settings section shape)
// ---------------------------------------------------------------------------

function egressLauncherLimits() {
  return [
    'runtime:settings --egress-launcher-plan is a dry-run PLANNER: it reads the current egress activation state and the personal ~/.claude prototype hooks READ-ONLY, and records an activation runbook in an agentic-plugins-owned artifact. It NEVER writes host config, ~/.agentic-plugins/config.local.toml, the credential, or ~/.claude/settings.json — applying the plan is an explicit USER action (ADR-0041 §2c/§12).',
    'The credential is NEVER read: only whether TELEGRAM_BOT_TOKEN is present (credentialPresent) is surfaced. The token value is never captured, logged, echoed, or written to the artifact (§2b), and a scrubSecrets pass fail-closes the write if any secret-shaped value ever reached it (§5).',
    'Egress activation + recipient come ONLY from env or the fail-closed-verified ~/.agentic-plugins/config.local.toml (§2c); the recommended layout keeps channel + chat-id in that file and the token in env. The egress_* keys are deliberately OUTSIDE runtime-config CONFIG_KEYS, so --apply can never write them and this planner never adds them.',
    'Prototype detection is Claude-scoped (the personal ~/.claude/telegram-notify.mjs hook) and matches by EXACT path, not basename — an unrelated same-named script is not flagged. A missing/unreadable settings.json simply omits the retire step (fail-closed).',
    'Per-machine: each machine activates independently (§8). Run the planner on every machine; the same chat-id + a per-machine token fan all machines into one chat.',
  ];
}

// Build the egress-launcher plan section (+ record the plan artifact). All reads
// are READ-ONLY (loadEgressActivation, loadEgressHeadlineOptIn,
// detectPrototypeHooks); nothing is mutated. `env` is injected so tests run
// hermetically (ambient real credentials/chat-id never enter). The credential is
// never read into the result.
// GATHER (machine-bootstrap-contract.md §1.3): every read — the egress activation,
// the headline opt-in, and the ~/.claude prototype hooks — up front, so the pure
// builder below touches no filesystem. `env` is injected so tests run hermetically
// (ambient real credentials/chat-id never enter). The credential is never read into
// the result.
export async function gatherEgressLauncherInputs({ repoRoot, homeDir, env = {} }) {
  return {
    activation: loadEgressActivation({ repoRoot, homeDir, env }),
    headlineOn: loadEgressHeadlineOptIn({ repoRoot, homeDir, env }),
    prototype: await detectPrototypeHooks({ homeDir }),
  };
}

// PURE BUILD (machine-bootstrap-contract.md §1.3): deterministic over the gathered
// reads + injected clock (`now`) + injected `runId`. No fs, no randomBytes. Returns
// { section, artifactBody }; the caller owns the persist target (repo-relative for
// settings, machine-global for bootstrap).
export function buildEgressLauncherPlanSection({ gathered, host = 'claude', now = new Date(), runId, runtimeVersion = RUNTIME_VERSION }) {
  const { activation, headlineOn, prototype } = gathered;
  const resolvedHost = VALID_HOSTS.has(host) ? host : 'claude';
  const mode = computeEgressLauncherMode({ activation, prototype });

  const steps = buildSteps({ mode, activation, prototype, headlineOn });
  const createdAt = now.toISOString();

  // activation_state: NO credential value. recipient (chat-id, routing not
  // secret per §2b) is surfaced only when active — the operator's own configured
  // value they can copy to their other machines.
  const activationState = {
    active: activation.active,
    reason: activation.reason,
    channel: activation.channel,
    source: activation.source,
    channel_source: activation.channelSource,
    recipient_source: activation.recipientSource,
    recipient: activation.active ? activation.recipient : null,
    credential_present: activation.credentialPresent,
    local_reason: activation.localReason,
    headline_opt_in: headlineOn,
  };

  const artifactBody = {
    schema_version: EGRESS_LAUNCHER_PLAN_SCHEMA_VERSION,
    runtime_version: runtimeVersion,
    kind: EGRESS_LAUNCHER_PLAN_KIND,
    run_id: runId,
    surface: 'settings',
    status: 'planned',
    created_at: createdAt,
    repo_root_pointer: '.',
    host: resolvedHost,
    mode,
    activation_state: activationState,
    prototype,
    steps,
    limits: egressLauncherLimits(),
    boundary: {
      writes_host_config: false,
      writes_activation: false,
      writes_credential: false,
      installs_anything: false,
    },
  };

  return {
    section: {
      requested: true,
      executed: true,
      status: 'planned',
      host: resolvedHost,
      mode,
      activation_state: activationState,
      prototype,
      steps,
      config_local_path_pointer: join('~', '.agentic-plugins', 'config.local.toml'),
      // Persist-result pointer; the orchestrator overwrites this in place (preserving
      // key position) after it writes artifactBody to the caller-chosen target.
      artifact: { written: true },
      limits: egressLauncherLimits(),
    },
    artifactBody,
  };
}

// ORCHESTRATOR (settings surface): gather → deterministic build → persist repo-
// relative. Behavior-compatible with the pre-§1.3 single function. Bootstrap composes
// gatherEgressLauncherInputs + buildEgressLauncherPlanSection itself and persists
// artifactBody under its machine-global run instead (§10).
export async function buildEgressLauncherPlan({
  repoRoot,
  homeDir,
  env = {},
  host = 'claude',
  now = new Date(),
  runtimeVersion = RUNTIME_VERSION,
} = {}) {
  const gathered = await gatherEgressLauncherInputs({ repoRoot, homeDir, env });
  const runId = makeEgressLauncherRunId(now);
  const { section, artifactBody } = buildEgressLauncherPlanSection({ gathered, host, now, runId, runtimeVersion });
  const pointers = await writeEgressLauncherPlanArtifact({ repoRoot, artifact: artifactBody });
  section.artifact = { written: true, ...pointers };
  return section;
}
