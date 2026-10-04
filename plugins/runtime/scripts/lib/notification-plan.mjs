// ADR-0040 §4 Codex notification-channel M1 plan lib.
//
// `runtime:settings --notification-plan` plans the two Codex-native attention
// channels as FRAGMENTS + a recorded plan artifact, per the M1 precedent ADR-0038
// established (that ADR is superseded by ADR-0057, which removed the permission
// advisory it shipped; the render-and-record SHAPE it introduced outlived it and
// is what this plan follows): render + record ONLY — host config is NEVER written, and the
// rendered receiver scripts are NEVER installed by runtime (installing them at
// the stable home location, e.g. ~/.agentic-plugins/bin/, is an explicit USER
// action).
//
//   (a) `notify=` — user-layer ~/.codex/config.toml ONLY (the project layer
//       denylists the key and profile tables reject it). The key is a
//       single-key FULL REPLACE, so the plan performs a MANDATORY read-check
//       of any existing value: when a user notifier already exists, the plan
//       renders a wrapper-chaining script (invoke the prior notifier + ours)
//       and points the fragment at the chain instead of clobbering
//       (wrapper-chaining is an acceptance criterion of ADR-0040 §4).
//   (b) `tui.notifications` — approval-time attention within its documented
//       limits (TUI-only, default-unfocused condition, OSC 9/BEL terminal
//       dependence, no external program, no payload).
//
// Receiver-shuttle constraint (ADR-0040 §4): the fragment must NOT point into
// a version-pinned plugin cache path (Claude's cache is per-version; a pinned
// path goes stale on every runtime upgrade and a static config value has no
// re-discovery opportunity). The plan therefore renders a thin SHUTTLE script
// that re-resolves the current runtime root per the ADR-0039 §5 discovery
// ladder (env override → Claude cache SemVer-max → Codex fixed cache) and
// delegates to `notify.mjs emit`; the fragment invokes the shuttle via the
// per-OS canonical argv (expectedCodexNotifyArgv): `/usr/bin/env node` on
// POSIX (an explicit Node-on-PATH requirement; doctor's hook analyzer flags
// commands that START with a bare `node` — this env-prefixed form is the
// shape it deliberately does not warn about) and the render machine's own
// node executable path on win32, where `/usr/bin/env` does not exist.
//
// Receiver input contract (source-verified at codex-cli 0.142.5,
// legacy_notify.rs): the payload arrives as the LAST argv argument, kebab-case
// JSON with exactly one variant (`"type": "agent-turn-complete"`), an
// undocumented `client` field that must be tolerated, and a nullable
// `last-assistant-message`.
//
// The plan artifact reuses the settings-artifact SHAPE (fresh per-run
// directory + overwritten latest.json singleton) under its own
// `.agentic-plugins/runs/notification/` family — the same
// "point-in-time snapshot" reasoning the retired ADR-0038 permission advisory
// family used (lib/permission-artifacts.mjs, removed by ADR-0057), and the
// same reason it does NOT share the runs/settings family: doctor reads the
// latest settings EXECUTION artifact for retry classification, and a plan run
// overwriting that pointer would clobber it (the exact bug the ADR-0038 cross-host
// artifact consolidation fixed, recorded here as history — see ADR-0057).

import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNTIME_VERSION } from '../version.mjs';
import { resolveContainedSync } from './path-containment.mjs';
import { parseCodexConfigToml, readCodexConfigToml } from './codex-config.mjs';
import { substituteOnce } from './statusline-plan.mjs';
import { renderCodexTuiTableToml, tomlBasicString } from './toml.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// 1.1 — `read_check.tui_notifications_form` (ADR-0040 §4b). The `-latest-`
// POINTER schema deliberately stays 1.0: its shape (run id, status, mode,
// pointer) carries none of the changed fields, and the report and pointer
// schemas are independently versioned.
export const NOTIFICATION_PLAN_SCHEMA_VERSION = 'runtime-notification-plan-1.1';
export const NOTIFICATION_PLAN_LATEST_SCHEMA_VERSION = 'runtime-notification-plan-latest-1.0';
export const NOTIFICATION_PLAN_KIND = 'notification-plan';

// The on-disk family segment under .agentic-plugins/runs/. Registered in
// lib/state-readers.mjs RUNTIME_ARTIFACT_FAMILIES so the doctor inventory +
// retention reporting covers it.
export const NOTIFICATION_ARTIFACT_FAMILY = 'notification';

export const NOTIFICATION_PLAN_MODES = Object.freeze([
  'direct', // no existing user notifier — fragment points at the shuttle
  'wrapper-chain', // existing notifier preserved via the chain script
  'already-configured', // existing notify already points at our receiver
  'manual-merge', // existing notify present but not parseable as a string argv
]);

export const NOTIFICATION_PLAN_STATUSES = Object.freeze(['planned', 'blocked']);

export const NOTIFICATION_RUN_ID_RE = /^notification-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

// Stable receiver install home (USER-installed; runtime never writes it).
export const RECEIVER_INSTALL_DIR_POINTER = '~/.agentic-plugins/bin';
export const SHUTTLE_BASENAME = 'codex-notify-shuttle.mjs';
export const CHAIN_BASENAME = 'codex-notify-chain.mjs';

// The tui.notifications recommendation (ADR-0040 §4b): approval-requested has
// delivery priority over agent-turn-complete in the Codex TUI coalescing.
export const TUI_NOTIFICATIONS_VALUES = Object.freeze(['approval-requested', 'agent-turn-complete']);

// The closed set of trust classifications `parseCodexConfigToml`
// (lib/codex-config.mjs) assigns to a [tui] notifications capture. Exhaustive by construction and fail-closed
// to `invalid`; consumers interpret THIS, never the raw.
export const TUI_NOTIFICATIONS_FORMS = Object.freeze(['absent', 'true', 'false', 'array', 'invalid']);

// SemVer with optional prerelease AND optional build metadata — `1.2.3+build`
// is a valid version whose metadata is ignored by precedence rules.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// ---------------------------------------------------------------------------
// Fragment renderers
// ---------------------------------------------------------------------------

// Full TOML basic-string escape: backslash, quote, named control escapes, other
// C0/DEL as \uXXXX — safe for a home path that could theoretically carry a control
// char on POSIX. Canonical home is lib/toml.mjs (this module's copy and settings.mjs's
// had drifted into two byte-identical definitions); re-exported to preserve this
// module's public surface.
export { tomlBasicString };

// The CANONICAL notify= argv for one render machine — the single source the
// fragment renderer AND the planner's already-configured check consume, so
// "what we tell the operator to merge" and "what the planner later recognizes
// as ours" cannot drift (ADR-0048 §2's single-policy-definition rule, applied
// to notify). Bootstrap's notify.codex.configured exact probe consumed it too
// until ADR-0064 slice R4n1 removed that step.
//
// Per-OS shape (macro notify-axis slice):
//   - POSIX keeps `/usr/bin/env node <receiver>` — Node-on-PATH via env,
//     consistent with doctor's bare-`node` portability diagnostics, and the
//     form already merged on live machines (an exact probe must keep
//     matching them).
//   - win32 has no `/usr/bin/env`, and a bare `node` inherits exactly the
//     PATH fragility doctor warns about — so the render-machine's OWN
//     `process.execPath` is interpolated instead. A fragment is a
//     machine-local artifact rendered ON the machine it configures, so an
//     absolute path is honest there; on typical Windows installs it is the
//     version-free `C:\\Program Files\\nodejs\\node.exe`. (A version-managed
//     Windows Node — nvm-windows — can still pin a per-version path; the plan
//     section's limits line names that residual.)
export function expectedCodexNotifyArgv({ receiverPath, platform = process.platform, execPath = process.execPath }) {
  return platform === 'win32'
    ? [String(execPath), String(receiverPath)]
    : ['/usr/bin/env', 'node', String(receiverPath)];
}

// The notify= fragment — never a version-pinned plugin cache path; Codex
// appends the payload JSON as one extra argv item. Renders exactly
// expectedCodexNotifyArgv (see above) so the already-configured check and the
// fragment agree by construction.
export function renderCodexNotifyFragmentToml({ receiverPath, platform = process.platform, execPath = process.execPath }) {
  const argv = expectedCodexNotifyArgv({ receiverPath, platform, execPath });
  return `notify = [${argv.map((item) => tomlBasicString(item)).join(', ')}]\n`;
}

export function renderCodexTuiNotificationsFragmentToml() {
  // Delegates to the ONE [tui] composer (lib/toml.mjs) so this fragment and
  // the statusline plan's status_line fragment can never hand the operator
  // two competing [tui] headers for one table (ADR-0048 statusline slice).
  return renderCodexTuiTableToml({ notifications: [...TUI_NOTIFICATIONS_VALUES] });
}

// ---------------------------------------------------------------------------
// Receiver script renderers (rendered TEXT — runtime never executes these)
// ---------------------------------------------------------------------------

// Receiver template sources ship with the plugin at
// <plugin-root>/receivers/ (this lib is at <plugin-root>/scripts/lib/).
const RECEIVERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'receivers');

function readReceiverTemplate(templateBasename) {
  // Canonical containment, like every other packaged asset (ADR-0051
  // §Decision 2 as extended 2026-08-14). This is the higher-stakes half of
  // that class: the rendered text is CODE offered to the operator for
  // installation, so a receivers/ directory or template that resolves outside
  // the package puts unowned content into something a person is about to run.
  // A mis-packaged install — a build step that followed or created a symlink,
  // a checkout sharing a directory — is the failure mode this catches; the
  // package is supposed to be self-contained, and a hash over content it does
  // not own identifies the wrong bytes.
  const located = resolveContainedSync(RECEIVERS_DIR, templateBasename);
  if (located.status !== 'ok') {
    throw new Error(`receiver template ${templateBasename} could not be resolved inside the runtime package (${located.status}${located.code ? `: ${located.code}` : ''}) at ${located.path}`);
  }
  return readFileSync(located.canonicalPath, 'utf8');
}

// Rendered-literal guards: every value interpolated into a script template is
// validated first so a hostile config value cannot escape its literal context.
function assertSemver(value, label) {
  if (!SEMVER_RE.test(String(value))) {
    throw new Error(`${label} must be a SemVer version, got '${value}'`);
  }
  return String(value);
}

function jsStringLiteral(value) {
  return JSON.stringify(String(value));
}

function jsStringArrayLiteral(values) {
  if (!Array.isArray(values) || !values.every((item) => typeof item === 'string')) {
    throw new Error('argv literal requires an array of strings');
  }
  return `[${values.map((item) => JSON.stringify(item)).join(', ')}]`;
}

// The thin receiver shuttle. Standalone (no runtime import — it runs from the
// user's stable home BEFORE the runtime root is known): re-resolves the
// runtime root per the ADR-0039 §5 ladder, version-gates it, maps the Codex
// notify payload onto the ADR-0040 §1 event contract, and delegates to
// `notify.mjs emit`. Fail-closed silent like every notification surface:
// exit 0 always, nothing on stdout, at most one stderr diagnostic line.
//
// The receiver SOURCES live under plugins/runtime/receivers/ as render-input
// data, deliberately outside plugins/runtime/scripts/: the ADR-0035 §4
// executor guard's domain is code the runtime itself executes, and these
// receivers are never imported or spawned by runtime — the plan renders them
// into an artifact and the USER installs and runs them. Each placeholder is
// substituted exactly once; substituteOnce fail-closes on template drift.
// `template` (the receiver source TEXT) is injectable so the pure plan builder can
// render without a disk read (machine-bootstrap-contract.md §1.3 "injected …
// templates"); omitted, it reads the plugin-shipped source as before.
export function renderCodexNotifyShuttleScript({ minRuntimeVersion = RUNTIME_VERSION, template } = {}) {
  const minVersion = assertSemver(minRuntimeVersion, 'minRuntimeVersion');
  return substituteOnce(
    template ?? readReceiverTemplate(SHUTTLE_BASENAME),
    "'__AGENTIC_MIN_RUNTIME_VERSION__'",
    jsStringLiteral(minVersion),
    'MIN_RUNTIME_VERSION',
  );
}

// The wrapper-chaining receiver (acceptance criterion): preserves an existing
// user notifier by invoking it AND the shuttle, both fire-and-forget. The
// prior notifier's argv is embedded as a validated JS string-array literal.
// Substitution order matters: the shuttle path goes in first, so prior-argv
// DATA that happens to contain a placeholder token is inserted afterwards and
// never re-scanned (and substituteOnce's exactly-once check fail-closes if an
// earlier substitution ever introduced a duplicate token).
export function renderCodexNotifyChainScript({ priorNotify, shuttleInstallPath, template }) {
  if (!Array.isArray(priorNotify) || priorNotify.length === 0) {
    throw new Error('renderCodexNotifyChainScript requires a non-empty prior notify argv');
  }
  const priorLiteral = jsStringArrayLiteral(priorNotify);
  const withShuttle = substituteOnce(
    template ?? readReceiverTemplate(CHAIN_BASENAME),
    '"__AGENTIC_SHUTTLE_PATH__"',
    jsStringLiteral(shuttleInstallPath),
    'SHUTTLE_PATH',
  );
  return substituteOnce(
    withShuttle,
    '["__AGENTIC_PRIOR_NOTIFY__"]',
    priorLiteral,
    'PRIOR_NOTIFY',
  );
}


// ---------------------------------------------------------------------------
// Artifact (settings-artifact shape: per-run dir + latest.json singleton)
// ---------------------------------------------------------------------------

export function makeNotificationRunId(now) {
  const d = now instanceof Date ? now : new Date(now);
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `notification-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function isValidNotificationRunId(runId) {
  return typeof runId === 'string' && NOTIFICATION_RUN_ID_RE.test(runId);
}

export function validateNotificationRunId(runId) {
  if (!isValidNotificationRunId(runId)) {
    throw new Error(
      `invalid notification run id '${runId}' (expected notification-YYYYMMDDTHHMMSSZ-<6hex>)`,
    );
  }
  return runId;
}

export function notificationRunRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', 'runs', NOTIFICATION_ARTIFACT_FAMILY);
}

export function notificationRunDir(repoRoot, runId) {
  return resolve(notificationRunRoot(repoRoot), validateNotificationRunId(runId));
}

export function notificationArtifactFile(repoRoot, runId) {
  return resolve(notificationRunDir(repoRoot, runId), 'plan.json');
}

export function notificationLatestFile(repoRoot) {
  return resolve(notificationRunRoot(repoRoot), 'latest.json');
}

function pointer(repoRoot, path) {
  const rel = relative(repoRoot, path).split(sep).join('/');
  return rel || basename(path);
}

// Atomic write (temp + same-directory rename): a crash can never leave a
// half-written plan.json / latest.json. (The precedent was the ADR-0038
// permission advisory artifact writer, removed by ADR-0057; the rule outlived it.)
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

const ARTIFACT_KEYS = new Set([
  'schema_version', 'runtime_version', 'kind', 'run_id', 'surface', 'status',
  'created_at', 'repo_root_pointer', 'host', 'read_check', 'recommended',
  'fragments', 'scripts', 'receiver_contract', 'limits', 'boundary',
]);
const BOUNDARY_KEYS = new Set(['writes_host_config', 'installs_receiver']);

function onlyKnownKeys(obj, allowed) {
  return Boolean(obj) && typeof obj === 'object' && Object.keys(obj).every((k) => allowed.has(k));
}

export function isValidNotificationPlanArtifact(artifact) {
  if (!onlyKnownKeys(artifact, ARTIFACT_KEYS)) return false;
  if (artifact.schema_version !== NOTIFICATION_PLAN_SCHEMA_VERSION) return false;
  if (artifact.kind !== NOTIFICATION_PLAN_KIND) return false;
  if (!isValidNotificationRunId(artifact.run_id)) return false;
  if (artifact.surface !== 'settings') return false;
  if (!NOTIFICATION_PLAN_STATUSES.includes(artifact.status)) return false;
  if (typeof artifact.created_at !== 'string' || !artifact.created_at) return false;
  if (artifact.repo_root_pointer !== '.') return false;
  if (artifact.host !== 'codex') return false;
  if (!artifact.read_check || typeof artifact.read_check !== 'object') return false;
  // Schema 1.1's defining field is validated, not merely declared: an artifact
  // carrying a raw without its trust classification is the surface this version
  // exists to remove, so writing one is refused.
  if (!TUI_NOTIFICATIONS_FORMS.includes(artifact.read_check.tui_notifications_form)) return false;
  if (!artifact.recommended || typeof artifact.recommended !== 'object') return false;
  if (!NOTIFICATION_PLAN_MODES.includes(artifact.recommended.mode)) return false;
  if (!artifact.fragments || typeof artifact.fragments !== 'object') return false;
  if (!artifact.scripts || typeof artifact.scripts !== 'object') return false;
  if (!Array.isArray(artifact.limits) || !artifact.limits.every((l) => typeof l === 'string')) return false;
  if (!onlyKnownKeys(artifact.boundary, BOUNDARY_KEYS)) return false;
  if (artifact.boundary.writes_host_config !== false) return false;
  if (artifact.boundary.installs_receiver !== false) return false;
  return true;
}

export async function writeNotificationPlanArtifact({ repoRoot, artifact }) {
  if (!isValidNotificationPlanArtifact(artifact)) {
    throw new Error(
      'writeNotificationPlanArtifact: artifact failed validation (refusing to write a malformed notification plan)',
    );
  }
  const runId = artifact.run_id;
  const reportPath = notificationArtifactFile(repoRoot, runId);
  await writeJsonAtomic(reportPath, artifact);
  await writeJsonAtomic(notificationLatestFile(repoRoot), {
    schema_version: NOTIFICATION_PLAN_LATEST_SCHEMA_VERSION,
    kind: NOTIFICATION_PLAN_KIND,
    run_id: runId,
    surface: artifact.surface,
    status: artifact.status,
    host: artifact.host,
    mode: artifact.recommended.mode,
    updated_at: artifact.created_at,
    report_pointer: pointer(repoRoot, reportPath),
    run_pointer: pointer(repoRoot, dirname(reportPath)),
  });
  return {
    run_id: runId,
    family: NOTIFICATION_ARTIFACT_FAMILY,
    run_pointer: pointer(repoRoot, notificationRunDir(repoRoot, runId)),
    report_pointer: pointer(repoRoot, reportPath),
    latest_pointer: pointer(repoRoot, notificationLatestFile(repoRoot)),
  };
}

// ---------------------------------------------------------------------------
// The plan builder (settings section shape)
// ---------------------------------------------------------------------------

function notificationPlanLimits({ chained, platform = process.platform }) {
  const limits = [
    'runtime:settings notification plan is a dry-run (M1): it renders the ~/.codex/config.toml fragments and receiver scripts and records them in an agentic-plugins-owned artifact, but NEVER writes host config or installs the scripts — installing the receiver at the stable home location and merging the fragments are explicit user actions.',
    `The notify= fragment targets the USER-layer config.toml only: the project-local .codex/config.toml layer denylists the notify key (silently stripped) and [profiles.*] tables reject it.`,
    'notify= fires only on agent-turn-complete (the payload enum has exactly one variant at the pinned Codex version) — it cannot deliver approval-time attention; the tui.notifications fragment covers approval-requested within its limits.',
    'tui.notifications limits: TUI-only (not codex exec), default-unfocused delivery condition, OSC 9/BEL delivery is terminal-emulator-dependent, no external program, no payload. It is also a full-replace key: merging replaces any custom notifications value.',
    platform === 'win32'
      ? 'The fragment invokes the receiver via this machine\'s own node executable path (Windows has no /usr/bin/env, and a bare `node` inherits the PATH fragility doctor diagnoses for bare-node hook commands). On a version-managed Node install (nvm-windows), that path can be per-version — re-render and re-merge the fragment after switching Node versions.'
      : 'The fragment invokes the receiver via /usr/bin/env node — Node must be on PATH for the process Codex runs the notifier from (the same portability constraint doctor diagnoses for bare-node hook commands).',
    'The receiver shuttle re-resolves the runtime plugin root on every invocation (env override, Codex fixed cache first via $CODEX_HOME, then Claude cache SemVer-max) so the fragment never points into a version-pinned plugin cache path.',
  ];
  if (chained) {
    limits.push(
      'Wrapper chaining preserves the existing notifier: its argv is embedded verbatim in the rendered chain script and in this plan artifact (local, gitignored) because chaining requires it; review the chain script before installing.',
    );
  }
  return limits;
}

const RECEIVER_CONTRACT = Object.freeze({
  payload_position: 'last argv argument',
  payload_format: 'kebab-case JSON (type, turn-id, input-messages, last-assistant-message)',
  variants: Object.freeze(['agent-turn-complete']),
  tolerated_fields: Object.freeze(['client']),
  nullable_fields: Object.freeze(['last-assistant-message']),
  node_requirement: 'POSIX: /usr/bin/env node (Node on PATH); win32: the render machine\'s node executable path (no /usr/bin/env there)',
});

// Build the Codex notification plan section (+ record the plan artifact).
// Reads the user-layer config.toml READ-ONLY via $CODEX_HOME (mirroring the
// canonical resolveCodexHome form in state-readers.mjs; never a hardcoded ~/.codex),
// decides direct vs wrapper-chain vs manual-merge, renders every fragment and
// receiver script as TEXT, and persists one plan artifact per run. Never
// writes host config; never creates the receiver install dir.
// The mandatory-read-check fail-closed predicate (machine-bootstrap-contract.md
// §notification): an unreadable user config that is NOT a plain absence blocks the
// plan. Defined ONCE so the gather (which then skips the receiver-template reads) and
// the pure build (which returns the blocked section) never drift on the condition.
function isNotificationReadBlocked(read) {
  return !read.ok && read.reason !== 'ENOENT' && read.reason !== 'ENOTDIR';
}

// GATHER (machine-bootstrap-contract.md §1.3): all reads — the user config.toml
// AND the plugin-shipped receiver templates — plus the homeDir-derived install
// paths, so the pure builder below touches no filesystem. Returns everything the
// deterministic build needs as data. When the read-check is blocked, the templates
// are skipped: the build discards them on that path, and reading them eagerly would
// turn a broken-install missing template into a throw where the old lazy code
// returned a clean blocked section. A caller that already holds the one config
// read (bootstrap's user-global readers, lib/codex-config.mjs readCodexConfigToml)
// passes it as `codexConfig`, so the file is read once per probe.
export async function gatherCodexNotificationInputs({ homeDir, env = {}, codexConfig = null }) {
  const { read, codexHomeSource } = codexConfig ?? await readCodexConfigToml({ homeDir, env });
  return {
    read,
    codexHomeSource,
    templates: isNotificationReadBlocked(read) ? null : {
      shuttle: readReceiverTemplate(SHUTTLE_BASENAME),
      chain: readReceiverTemplate(CHAIN_BASENAME),
    },
    installPaths: {
      shuttle: join(homeDir, '.agentic-plugins', 'bin', SHUTTLE_BASENAME),
      chain: join(homeDir, '.agentic-plugins', 'bin', CHAIN_BASENAME),
    },
  };
}

// PURE BUILD (machine-bootstrap-contract.md §1.3): deterministic over the gathered
// data + injected clock (`now`) + injected `runId` + injected templates. No fs, no
// randomBytes. Returns { section, artifactBody }; artifactBody is null on the blocked
// path (nothing to persist) and the caller owns the persist target (repo-relative for
// settings, machine-global for bootstrap).
export function buildCodexNotificationPlanSection({ gathered, now = new Date(), runId, runtimeVersion = RUNTIME_VERSION, platform = process.platform, execPath = process.execPath }) {
  const { read, codexHomeSource, templates, installPaths } = gathered;
  const shuttleInstallPath = installPaths.shuttle;
  const chainInstallPath = installPaths.chain;

  if (!read.ok && read.reason !== 'ENOENT' && read.reason !== 'ENOTDIR') {
    // Fail-closed: an unreadable user config means the MANDATORY read-check
    // cannot run, so no fragment is safe to recommend (a blind notify=
    // merge could clobber an invisible existing notifier).
    return {
      section: {
        requested: true,
        executed: true,
        status: 'blocked',
        host: 'codex',
        error: `user config.toml unreadable (${read.reason}); the mandatory notify read-check cannot run`,
        host_config: { read_only: true, codex_home_source: codexHomeSource, sources: [{ scope: 'user', status: 'unreadable' }] },
        read_check: { performed: false },
        recommended: null,
        expected_notify_argv: null,
        fragments: null,
        scripts: null,
        receiver_contract: RECEIVER_CONTRACT,
        artifact: { written: false, reason: 'read-check blocked' },
        limits: notificationPlanLimits({ chained: false, platform }),
      },
      artifactBody: null,
    };
  }

  const parsed = parseCodexConfigToml(read.ok ? read.text : '');

  const priorValues = parsed.notify.values;
  // Exact install-path match ONLY (Plan-verify peer MINOR): a basename
  // heuristic would misclassify an unrelated same-named notifier as ours and
  // silently drop it (skipping the wrapper chain that exists to preserve it).
  // A user copy at a custom path simply takes the wrapper-chain branch, which
  // preserves it like any other prior notifier.
  //
  // The two receiver paths are tracked SEPARATELY (ADR-0047 Review finding):
  // a chain install must keep its chain pointer through a re-render — the
  // chain forwards to the shuttle install path, so re-installing the
  // re-rendered shuttle is the whole migration. Presenting the direct
  // fragment there (and calling it idempotent) would clobber the chain and
  // silently drop the prior notifier the chain exists to preserve.
  // FULL canonical-argv equality ONLY (Refine-verify peer HIGH): the earlier
  // element-membership test classified `["custom-wrapper", "--forward-to",
  // <shuttle>, "--keep"]` as already-configured and re-rendered the DIRECT
  // fragment — clobbering the wrapper that referenced us. A config is "ours"
  // exactly when its argv IS the canonical argv this machine's fragment
  // renders (shuttle or chain form); anything else — our path embedded in a
  // foreign wrapper, a hand-drifted variant, a stale win32 execPath — takes
  // the ordinary non-empty branch, whose wrapper-chain PRESERVES it.
  const argvEquals = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]);
  const referencesShuttle = argvEquals(priorValues, expectedCodexNotifyArgv({ receiverPath: shuttleInstallPath, platform, execPath }));
  const referencesChain = argvEquals(priorValues, expectedCodexNotifyArgv({ receiverPath: chainInstallPath, platform, execPath }));
  const referencesOurReceiver = referencesShuttle || referencesChain;

  let mode;
  let warning = null;
  if (!parsed.notify.present) {
    mode = 'direct';
  } else if (referencesOurReceiver) {
    mode = 'already-configured';
    warning = referencesChain
      ? 'existing notify already points at the agentic-plugins wrapper chain; the chain forwards to the shuttle install path, so re-installing the re-rendered shuttle completes a migration — the fragment below reproduces the existing chain pointer and re-merging it is idempotent.'
      : 'existing notify already points at the agentic-plugins receiver; re-merging the fragment is idempotent.';
  } else if (Array.isArray(priorValues) && priorValues.length === 0) {
    // An empty argv array notifies nothing — there is no notifier to
    // preserve, so the direct fragment simply replaces it.
    mode = 'direct';
    warning = 'existing notify is an empty array (no notifier to preserve); the direct fragment replaces it.';
  } else if (Array.isArray(priorValues) && priorValues.length > 0) {
    mode = 'wrapper-chain';
    warning = 'existing notify found: notify is a single-key FULL REPLACE, so merging the direct fragment would clobber it — use the wrapper-chain fragment + chain script to preserve the existing notifier.';
  } else {
    mode = 'manual-merge';
    warning = 'existing notify found but not parseable as a flat string argv array; a safe chain cannot be rendered — merge manually (the direct fragment below replaces the existing value).';
  }

  const shuttleScript = renderCodexNotifyShuttleScript({ minRuntimeVersion: runtimeVersion, template: templates.shuttle });
  const chainScript = mode === 'wrapper-chain'
    ? renderCodexNotifyChainScript({ priorNotify: priorValues, shuttleInstallPath, template: templates.chain })
    : null;
  // A chain-already-configured install keeps its chain pointer: the existing
  // chain script (which wraps the prior notifier) stays untouched and the
  // fragment must reproduce it, never downgrade to the direct shuttle.
  const chainInUse = mode === 'wrapper-chain' || (mode === 'already-configured' && referencesChain);
  const receiverPath = chainInUse ? chainInstallPath : shuttleInstallPath;
  const expectedNotifyArgv = expectedCodexNotifyArgv({ receiverPath, platform, execPath });
  const notifyFragment = renderCodexNotifyFragmentToml({ receiverPath, platform, execPath });
  const tuiFragment = renderCodexTuiNotificationsFragmentToml();
  // The raw is shown to the operator, but it may not be presented as an
  // OBSERVED value unless the scan could classify it: a redefined [tui] table
  // or a trailing-junk line captures a canonical-LOOKING raw out of a config
  // Codex cannot load. This is the same defect the step judge refuses, one
  // level down — the artifact and the warning had it too.
  const tuiWarning = parsed.tuiNotifications.present
    ? (parsed.tuiNotifications.form === 'invalid'
      ? `an existing [tui] notifications assignment was found but could not be classified (${parsed.tuiNotifications.raw}) — a duplicate key, a redefined [tui] table, or a value this scan does not support. Normalize it to a single well-formed assignment under exactly one [tui] table before merging; notifications is a full-replace key.`
      : `existing [tui] notifications value found (${parsed.tuiNotifications.raw}); notifications is also a full-replace key — merging the fragment replaces it.`)
    : null;

  const limits = notificationPlanLimits({ chained: mode === 'wrapper-chain', platform });
  const createdAt = now.toISOString();
  const readCheck = {
    performed: true,
    config_path_scope: 'user',
    codex_home_source: codexHomeSource,
    config_present: read.ok,
    notify_present: parsed.notify.present,
    notify_parseable: Array.isArray(priorValues),
    notify_values: Array.isArray(priorValues) ? priorValues : null,
    notify_raw: parsed.notify.raw,
    tui_notifications_present: parsed.tuiNotifications.present,
    tui_notifications_raw: parsed.tuiNotifications.raw,
    // The trust classification the raw must be read through (schema 1.1). A raw
    // without it is exactly the misleading surface this slice closes.
    tui_notifications_form: parsed.tuiNotifications.form,
  };
  const recommended = {
    mode,
    receiver_install_dir_pointer: RECEIVER_INSTALL_DIR_POINTER,
    shuttle_install_path: shuttleInstallPath,
    chain_install_path: chainInUse ? chainInstallPath : null,
    fragment_target: 'user-layer config.toml (project layer denylists notify; profile tables reject it)',
  };
  const fragments = {
    notify_toml: notifyFragment,
    tui_notifications_toml: tuiFragment,
  };
  // The ONE argv this plan's fragment carries — persisted into the step's
  // `desired` seat so the exact probe binds to THIS plan's mode (shuttle vs
  // chain), not to whichever canonical form the operator happened to merge
  // (Refine-verify peer: a wrapper-chain plan wrongly merged as the direct
  // shuttle certified `satisfied` while the third-party notifier vanished).
  const expected_notify_argv = expectedNotifyArgv;
  const scripts = {
    shuttle: { install_path: shuttleInstallPath, content: shuttleScript },
    chain: chainScript === null ? null : { install_path: chainInstallPath, content: chainScript },
  };

  const artifactBody = {
    schema_version: NOTIFICATION_PLAN_SCHEMA_VERSION,
    runtime_version: runtimeVersion,
    kind: NOTIFICATION_PLAN_KIND,
    run_id: runId,
    surface: 'settings',
    status: 'planned',
    created_at: createdAt,
    repo_root_pointer: '.',
    host: 'codex',
    read_check: readCheck,
    recommended,
    fragments,
    scripts,
    receiver_contract: RECEIVER_CONTRACT,
    limits,
    boundary: { writes_host_config: false, installs_receiver: false },
  };

  return {
    section: {
      requested: true,
      executed: true,
      status: 'planned',
      host: 'codex',
      host_config: {
        read_only: true,
        codex_home_source: codexHomeSource,
        sources: [{ scope: 'user', status: read.ok ? 'readable' : 'missing' }],
      },
      read_check: readCheck,
      warning,
      tui_warning: tuiWarning,
      recommended,
      expected_notify_argv,
      fragments,
      scripts,
      receiver_contract: RECEIVER_CONTRACT,
      // Persist-result pointer; the orchestrator overwrites this in place (preserving
      // key position) after it writes artifactBody to the caller-chosen target.
      artifact: { written: true },
      limits,
    },
    artifactBody,
  };
}

// ORCHESTRATOR (settings surface): gather → deterministic build → persist repo-
// relative. Behavior-compatible with the pre-§1.3 single function. Until ADR-0064
// slice R4n1, bootstrap composed gatherCodexNotificationInputs +
// buildCodexNotificationPlanSection itself and persisted artifactBody under its
// machine-global run (§10); this orchestrator is now their only caller.
export async function buildCodexNotificationPlan({
  repoRoot,
  homeDir,
  env = {},
  now = new Date(),
  runtimeVersion = RUNTIME_VERSION,
  // Forwarded to the pure builder (Refine-verify peer: without these the
  // injectable per-OS seam stopped at the builder and a deterministic win32
  // end-to-end could not reach this wrapper).
  platform = process.platform,
  execPath = process.execPath,
} = {}) {
  const gathered = await gatherCodexNotificationInputs({ homeDir, env });
  const runId = makeNotificationRunId(now);
  const { section, artifactBody } = buildCodexNotificationPlanSection({ gathered, now, runId, runtimeVersion, platform, execPath });
  if (!artifactBody) return section;
  const pointers = await writeNotificationPlanArtifact({ repoRoot, artifact: artifactBody });
  section.artifact = { written: true, ...pointers };
  return section;
}
