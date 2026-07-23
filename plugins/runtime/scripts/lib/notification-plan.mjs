// ADR-0040 §4 Codex notification-channel M1 plan lib.
//
// `runtime:settings --notification-plan` plans the two Codex-native attention
// channels as FRAGMENTS + a recorded plan artifact, per the ADR-0038 M1
// precedent: render + record ONLY — host config is NEVER written, and the
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
// "point-in-time snapshot" reasoning as lib/permission-artifacts.mjs, and the
// same reason it does NOT share the runs/settings family: doctor reads the
// latest settings EXECUTION artifact for retry classification, and a plan run
// overwriting that pointer would clobber it (the exact bug the ADR-0038
// cross-host artifact consolidation fixed).

import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNTIME_VERSION } from '../version.mjs';
import { readTextIfExists } from './state-readers.mjs';
import { renderCodexTuiTableToml, tomlBasicString } from './toml.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NOTIFICATION_PLAN_SCHEMA_VERSION = 'runtime-notification-plan-1.0';
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

// SemVer with optional prerelease AND optional build metadata — `1.2.3+build`
// is a valid version whose metadata is ignored by precedence rules.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// ---------------------------------------------------------------------------
// Read-check parser — top-level `notify` + `[tui] notifications`, READ-ONLY
// ---------------------------------------------------------------------------

// Scan a raw capture for basic ("...") / literal ('...') TOML string elements.
// Returns null when any non-string, non-separator token appears — a notify
// value that is not a flat string array cannot be safely chained.
//
// Decode fidelity is a chaining-safety requirement (Plan-verify peer MAJOR):
// the wrapper chain EXECUTES this parsed argv, so a string form this scanner
// cannot decode faithfully must return null (→ manual-merge), never a
// silently-different value. Basic strings decode the full TOML escape set
// (\b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX); any other escape and the
// triple-quoted multi-line forms are rejected as unparseable.
function extractStringElements(arrayText) {
  const inner = arrayText.trim().replace(/^\[/, '').replace(/\]$/, '');
  const values = [];
  let i = 0;
  // Separator discipline (Refine-verify peer MEDIUM): after a closed string,
  // the ONLY tokens allowed before the next string are whitespace/comments and
  // exactly one comma. `["a" "b"]` is not TOML — treating whitespace as a
  // separator parsed it into two elements and let a malformed config judge
  // `satisfied` against §6.1's "unparseable → pending" rule.
  let expectSeparator = false;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i += 1; continue; }
    if (ch === ',') {
      if (!expectSeparator) return null; // leading/double comma — not a flat string array
      expectSeparator = false;
      i += 1;
      continue;
    }
    if (ch === '#') {
      // Comment inside a multi-line array — skip to end of line.
      const nl = inner.indexOf('\n', i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (ch === '"') {
      if (expectSeparator) return null; // two strings with no comma between
      // Triple-quoted multi-line basic string — not supported; fail safe.
      if (inner.startsWith('"""', i)) return null;
      let out = '';
      i += 1;
      let closed = false;
      while (i < inner.length) {
        const c = inner[i];
        if (c === '\\') {
          const next = inner[i + 1];
          if (next === undefined) return null;
          if (next === 'b') { out += '\b'; i += 2; continue; }
          if (next === 't') { out += '\t'; i += 2; continue; }
          if (next === 'n') { out += '\n'; i += 2; continue; }
          if (next === 'f') { out += '\f'; i += 2; continue; }
          if (next === 'r') { out += '\r'; i += 2; continue; }
          if (next === '"') { out += '"'; i += 2; continue; }
          if (next === '\\') { out += '\\'; i += 2; continue; }
          if (next === 'u' || next === 'U') {
            const width = next === 'u' ? 4 : 8;
            const hex = inner.slice(i + 2, i + 2 + width);
            if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
            let decoded;
            try {
              decoded = String.fromCodePoint(Number.parseInt(hex, 16));
            } catch {
              return null; // out-of-range code point
            }
            out += decoded;
            i += 2 + width;
            continue;
          }
          // Unknown escape — decoding it as anything would risk chaining a
          // DIFFERENT command than the one configured.
          return null;
        }
        if (c === '"') { closed = true; i += 1; break; }
        out += c;
        i += 1;
      }
      if (!closed) return null;
      values.push(out);
      expectSeparator = true;
      continue;
    }
    if (ch === "'") {
      if (expectSeparator) return null; // two strings with no comma between
      // Triple-quoted multi-line literal string — not supported; fail safe.
      if (inner.startsWith("'''", i)) return null;
      const end = inner.indexOf("'", i + 1);
      if (end === -1) return null;
      values.push(inner.slice(i + 1, end));
      expectSeparator = true;
      i = end + 1;
      continue;
    }
    // Any other token (number, bool, nested table…) — not a string argv.
    return null;
  }
  return values;
}

// Capture a TOML array value starting at lines[startIndex] whose text after
// `=` is firstRemainder. String-state + bracket-depth aware, so `#` and `]`
// INSIDE quoted elements never terminate the capture, and a trailing comment
// after the closing bracket is never captured. Multi-line arrays accumulate
// until the depth returns to zero (an unclosed array captures to EOF and
// parses as non-array).
function captureTomlArray(lines, startIndex, firstRemainder) {
  let raw = '';
  let depth = 0;
  let sawOpen = false;
  let inString = null; // '"' | "'" | null
  let escaped = false;
  let lineIndex = startIndex;
  let text = firstRemainder;
  for (;;) {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        raw += ch;
        if (escaped) { escaped = false; continue; }
        if (inString === '"' && ch === '\\') { escaped = true; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '#') break; // comment — rest of this physical line ignored
      raw += ch;
      if (ch === '"' || ch === "'") { inString = ch; continue; }
      if (ch === '[') { depth += 1; sawOpen = true; continue; }
      if (ch === ']') {
        depth -= 1;
        if (sawOpen && depth === 0) {
          // The remainder of the closing physical line rides back so the
          // caller can refuse trailing non-comment junk (`= ["a"] garbage`)
          // instead of silently accepting a line no TOML parser would.
          return { raw: raw.trim(), nextIndex: lineIndex + 1, closed: true, trailing: text.slice(i + 1) };
        }
      }
    }
    lineIndex += 1;
    if (!sawOpen || lineIndex >= lines.length) {
      return { raw: raw.trim(), nextIndex: lineIndex, closed: !sawOpen, trailing: '' };
    }
    raw += '\n';
    text = lines[lineIndex];
  }
}

// Minimal READ-ONLY scan of ~/.codex/config.toml for exactly the two keys the
// notification plan needs: the top-level `notify` value (present/raw/argv) and
// `[tui] notifications`. Top-level keys are honored only before the first
// section header (TOML ordering); later duplicate assignments overwrite
// earlier ones (last-value-wins, mirroring the sibling read parsers).
export function parseCodexNotifyConfigToml(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let inTopLevel = true;
  let inTui = false;
  let tuiHeaderSeen = false;
  let tuiRedefined = false;
  // Per-key capture state: raw text + the strictness facts an EXACT probe
  // needs (Plan-verify peer BLOCKER — the earlier scan discarded them):
  // unclosed arrays, duplicate keys (invalid TOML, previously last-wins),
  // a redefined [tui] table, and trailing non-comment junk all resolve to
  // values:null (unparseable), never to a confidently wrong argv/item list.
  const states = { notify: null, tuiNotifications: null, tuiStatusLine: null };
  const record = (key, captured) => {
    if (states[key] !== null) {
      states[key] = { ...states[key], duplicate: true };
      return;
    }
    states[key] = {
      raw: captured.raw,
      closed: captured.closed === true,
      trailingOk: /^\s*(#.*)?$/.test(captured.trailing ?? ''),
      duplicate: false,
    };
  };
  let i = 0;
  // Multi-line-string state (Review peer BLOCKER): a line INSIDE a custom
  // triple-quoted value under [tui] can look exactly like `status_line = [...]`
  // and the line scanner certified it as the real key. Track open
  // basic/literal multi-line strings and skip every line inside one. The
  // tracking is conservative: an odd delimiter count toggles, and anything it
  // cannot follow leaves keys uncaptured (fail-closed: unparseable → null,
  // never a confidently wrong value).
  let openTriple = null; // '"""' | "'''" | null
  const toggleTriples = (line) => {
    let idx = 0;
    for (;;) {
      if (openTriple) {
        const close = line.indexOf(openTriple, idx);
        if (close === -1) return true; // still inside — whole line consumed
        idx = close + 3;
        openTriple = null;
        continue;
      }
      const b = line.indexOf('"""', idx);
      const l = line.indexOf("'''", idx);
      const next = b === -1 ? l : l === -1 ? b : Math.min(b, l);
      if (next === -1) return false;
      openTriple = line.slice(next, next + 3);
      idx = next + 3;
    }
  };
  while (i < lines.length) {
    const raw = lines[i];
    if (openTriple) {
      toggleTriples(raw);
      i += 1;
      continue;
    }
    const consumedByTriple = toggleTriples(raw);
    if (consumedByTriple) { i += 1; continue; }
    const stripped = raw.replace(/#.*/, '').trim();
    if (stripped.startsWith('[')) {
      inTopLevel = false;
      const isTui = /^\[tui\]$/.test(stripped);
      if (isTui && tuiHeaderSeen) tuiRedefined = true;
      if (isTui) tuiHeaderSeen = true;
      inTui = isTui;
      i += 1;
      continue;
    }
    if (inTopLevel) {
      const m = raw.match(/^\s*(?:"notify"|notify)\s*=\s*(.*)$/);
      if (m) {
        const captured = captureTomlArray(lines, i, m[1]);
        record('notify', captured);
        i = captured.nextIndex;
        continue;
      }
      // Dotted top-level forms of the [tui] table keys (valid TOML a
      // section-only scan would miss — Plan-verify peer findings).
      const dottedNotif = raw.match(/^\s*tui\s*\.\s*notifications\s*=\s*(.*)$/);
      if (dottedNotif) {
        const captured = captureTomlArray(lines, i, dottedNotif[1]);
        record('tuiNotifications', captured);
        i = captured.nextIndex;
        continue;
      }
      const dottedStatus = raw.match(/^\s*tui\s*\.\s*status_line\s*=\s*(.*)$/);
      if (dottedStatus) {
        const captured = captureTomlArray(lines, i, dottedStatus[1]);
        record('tuiStatusLine', captured);
        i = captured.nextIndex;
        continue;
      }
    } else if (inTui) {
      const mN = raw.match(/^\s*(?:"notifications"|notifications)\s*=\s*(.*)$/);
      if (mN) {
        const captured = captureTomlArray(lines, i, mN[1]);
        record('tuiNotifications', captured);
        i = captured.nextIndex;
        continue;
      }
      const mS = raw.match(/^\s*(?:"status_line"|status_line)\s*=\s*(.*)$/);
      if (mS) {
        const captured = captureTomlArray(lines, i, mS[1]);
        record('tuiStatusLine', captured);
        i = captured.nextIndex;
        continue;
      }
    }
    i += 1;
  }
  const resolve = (state, { tuiKey = false } = {}) => {
    if (state === null) return { present: false, raw: null, values: null };
    const clean = !state.duplicate && state.closed && state.trailingOk && !(tuiKey && tuiRedefined);
    const values = clean && state.raw.startsWith('[') ? extractStringElements(state.raw) : null;
    return { present: true, raw: state.raw, values };
  };
  const tuiNotifications = resolve(states.tuiNotifications, { tuiKey: true });
  return {
    notify: resolve(states.notify),
    tuiNotifications,
    tuiStatusLine: resolve(states.tuiStatusLine, { tuiKey: true }),
  };
}

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
// fragment renderer AND the notify.codex.configured exact probe consume, so
// "what we tell the operator to merge" and "what the judge later expects to
// observe" cannot drift (ADR-0048 §2's single-policy-definition rule, applied
// to notify).
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
// expectedCodexNotifyArgv (see above) so the exact probe and the fragment
// agree by construction.
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
  return readFileSync(join(RECEIVERS_DIR, templateBasename), 'utf8');
}

// Replace a placeholder that must occur EXACTLY once — zero or duplicate
// occurrences mean template drift (or an earlier substitution injected the
// token), and rendering a half-substituted receiver would be worse than
// failing the plan.
export function substituteOnce(template, placeholder, replacement, label) {
  const first = template.indexOf(placeholder);
  if (first === -1 || template.indexOf(placeholder, first + placeholder.length) !== -1) {
    throw new Error(`receiver template drift: expected exactly one ${label} placeholder`);
  }
  return template.slice(0, first) + replacement + template.slice(first + placeholder.length);
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

// Atomic write (temp + same-directory rename) — the permission-artifacts
// precedent: a crash can never leave a half-written plan.json / latest.json.
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
// sibling readCodexPermissionConfig resolution; never a hardcoded ~/.codex),
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
// returned a clean blocked section.
export async function gatherCodexNotificationInputs({ homeDir, env = {} }) {
  const codexHome = env && env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homeDir, '.codex');
  const codexHomeSource = env && env.CODEX_HOME ? 'CODEX_HOME env override' : 'default ~/.codex';
  const read = await readTextIfExists(join(codexHome, 'config.toml'));
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

  const parsed = parseCodexNotifyConfigToml(read.ok ? read.text : '');

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
  const tuiWarning = parsed.tuiNotifications.present
    ? `existing [tui] notifications value found (${parsed.tuiNotifications.raw}); notifications is also a full-replace key — merging the fragment replaces it.`
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
// relative. Behavior-compatible with the pre-§1.3 single function. Bootstrap composes
// gatherCodexNotificationInputs + buildCodexNotificationPlanSection itself and persists
// artifactBody under its machine-global run instead (§10).
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
