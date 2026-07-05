// plugins/runtime/scripts/lib/egress-config.mjs
//
// ADR-0041 §2c E1 (enumerated-metadata network egress) config layer — the
// "verified-ignored-local reader + separate E1 activation loader" the §10
// owner-decision gate hinges on (cfg subtask: the FIRST slice of the ~5-6 PR
// series and its feasibility de-risk).
//
// WHY THIS IS SEPARATE FROM lib/runtime-config.mjs's loadNotifyConfig path
// ---------------------------------------------------------------------------
// ADR-0040's notify loader resolves notify_channel from REPO config BEFORE user
// config (notify.mjs:138 `repoConfig[key] ?? userConfig[key]`), and
// intentionally lets a tracked `.agentic-plugins/config.toml` activate the
// LOCAL channels (file-log / macos-osascript). Egress (E1) is a third-party
// network effect; a tracked repo file activating it is a repo-controlled egress
// vector (clone-and-run would leak session metadata to an attacker-chosen
// recipient). ADR-0041 §2c therefore forbids E1 from riding that shared enum
// path: egress activation + recipient come ONLY from the operator environment
// or a fail-closed-verified ignored-local layer, and a token alone never
// activates egress.
//
// TWO STRUCTURAL CHOICES THAT MAKE §10 "mechanically proven safe in arbitrary
// consumer repos" HOLD AS IMPOSSIBILITY, NOT MERELY AS A VERIFIED PROPERTY
// ---------------------------------------------------------------------------
//   1. Separate key + enum surface. Egress uses its own EGRESS_CHANNELS enum
//      (never NOTIFY_CHANNELS) and its own `egress_*` keys parsed by a
//      dedicated parser. The egress keys are NOT in runtime-config's
//      CONFIG_KEYS, so the settings planner can never plan them into tracked
//      config.toml nor echo them to artifacts (§2c / §5). Admitting a new
//      service to EGRESS_CHANNELS can never let tracked notify_channel config
//      flip egress on.
//   2. User-home-ONLY verified-local layer. The single honored local file is
//      `~/.agentic-plugins/config.local.toml` — NEVER a repo-local file. A
//      user-home file is structurally outside the repo tree, so a repo cannot
//      ship it via `git clone`; "not repo-tracked" is proven by canonical path
//      (outside repoRoot), git-free — honoring §3's "no hidden git exec in the
//      emitter" (running `git check-ignore` on the hook path per event would be
//      both a latency cost and an executor-guard allowlist expansion). The file
//      is still fail-closed-verified before use: O_NOFOLLOW open (no symlinked
//      final component), regular file, operator-owned (uid), not group/other-
//      writable, opened-inode==resolved-inode (no open/read swap), and
//      canonically outside the repo. Any failure ⇒ the file is ignored and the
//      loader falls back to env, or to a silent no-op. The inside-repo proof is
//      MANDATORY: readVerifiedIgnoredLocal requires a repoRoot and refuses the
//      file without one, so a HOME-is-the-repo devcontainer/CI checkout cannot
//      let a cloned repo's tracked config.local.toml activate egress. (A user's
//      OWN dotfiles-tracked ~/.agentic-plugins is in-bounds — the threat model
//      is a cloned hostile repo, not the operator's own machine setup.)
//
// This module performs NO network I/O and imports NO network capability — it is
// pure config resolution (fs + env + a line parser). The pinned Telegram fetch,
// the buildEgressPayload enumerated-field builder, and the scanner/registry
// fetch gate are later slices (channel / gate); this slice therefore adds no
// fetch surface and can land before the keystone gate (ADR-0041 §11).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The E1 egress service enum — deliberately DISTINCT from NOTIFY_CHANNELS
// (lib/runtime-config.mjs) so egress activation can never share the tracked
// notify_channel resolution path (ADR-0041 §2c). v1: Telegram only; future
// services enter via ADR-0041 §9 admission (a service-specific ADR).
export const EGRESS_CHANNELS = Object.freeze(['telegram']);

// Operator-environment contract (ADR-0041 §2c). The credential is env-ONLY —
// never read from any file, and never returned by this module.
export const EGRESS_ENV_KEYS = Object.freeze({
  channel: 'AGENTIC_NOTIFY_EGRESS_CHANNEL', // explicit activation, separate from notify_channel
  recipient: 'TELEGRAM_CHAT_ID',
  credential: 'TELEGRAM_BOT_TOKEN',
});

// Verified-ignored-local file keys (activation + recipient only; NEVER the
// credential). Distinct from runtime-config's CONFIG_KEYS on purpose.
export const EGRESS_LOCAL_KEYS = Object.freeze({
  channel: 'egress_channel',
  recipient: 'egress_chat_id',
});

// The single honored verified-local file, under the user home (never the repo).
// Matches the existing `*.local.toml` gitignore slot (.gitignore:58).
export const EGRESS_LOCAL_FILENAME = 'config.local.toml';

export function egressLocalConfigPath(homeDir) {
  return path.join(homeDir, '.agentic-plugins', EGRESS_LOCAL_FILENAME);
}

// Dedicated line parser: reads ONLY the egress keys, so egress activation can
// neither leak into nor be planned out of the shared runtime-config key
// surface. Mirrors parseRuntimeConfigToml's line/quote/comment/CRLF handling
// (the repo's single TOML-subset behavior) with an egress-only key allowlist.
export function parseEgressLocalToml(text) {
  const out = {};
  const allow = new Set(Object.values(EGRESS_LOCAL_KEYS));
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const withoutComment = raw.replace(/#.*/, '').trim();
    if (!withoutComment || withoutComment.startsWith('[')) continue;
    const match = withoutComment.match(/^([A-Za-z0-9_.-]+)\s*=\s*("?)(.*?)\2\s*$/);
    if (!match) continue;
    const key = match[1].replace(/[.-]/g, '_');
    const value = match[3].trim();
    if (allow.has(key) && value) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verified-ignored-local reader (fail-closed)
// ---------------------------------------------------------------------------

function isUnder(child, parent) {
  if (!parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

// Fail-closed read of a candidate verified-ignored-local file. Returns
// { ok, reason, text }. `text` is the raw file content ONLY when ok===true;
// otherwise null. Every failure path (including an absent file) is a caller
// no-op — this function never throws.
//
// repoRoot is REQUIRED: the inside-repo proof is the load-bearing safety check
// (a user-home file is only safe because it is outside the repo tree), so a
// missing repoRoot fails closed rather than honoring the file unchecked.
//
// getuid: undefined ⇒ use the real process.getuid; null ⇒ ownership cannot be
// verified (e.g. Windows) ⇒ fail-closed; a function ⇒ use it (tests inject a
// mismatching uid). The credential is NEVER read here.
export function readVerifiedIgnoredLocal({ filePath, repoRoot = null, getuid } = {}) {
  const resolveUid = getuid === undefined
    ? (typeof process.getuid === 'function' ? process.getuid : null)
    : getuid;

  // Without a repoRoot the inside-repo proof cannot run; a user-home file could
  // then be a repo-tracked file when HOME is the repo root (devcontainer / CI /
  // workspace), letting a hostile clone ship an activating config.local.toml.
  // Fail closed (Codex review MAJOR).
  if (!repoRoot) return { ok: false, reason: 'repo-root-required', text: null };

  // O_NOFOLLOW refuses a symlinked final component; O_NONBLOCK never blocks on
  // a fifo/device. Flags are added only where the platform defines them; on a
  // platform lacking O_NOFOLLOW the ownership + inside-repo gates below still
  // fail-close (no getuid ⇒ ownership-unverifiable; a symlink into the repo is
  // caught by the canonical inside-repo check).
  let flags = fs.constants.O_RDONLY;
  if (typeof fs.constants.O_NOFOLLOW === 'number') flags |= fs.constants.O_NOFOLLOW;
  if (typeof fs.constants.O_NONBLOCK === 'number') flags |= fs.constants.O_NONBLOCK;

  let fd;
  try {
    fd = fs.openSync(filePath, flags);
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'absent', text: null };
    if (code === 'ELOOP' || code === 'EMLINK') return { ok: false, reason: 'symlink', text: null };
    return { ok: false, reason: 'unreadable', text: null };
  }

  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not-regular-file', text: null };
    if (typeof resolveUid !== 'function') return { ok: false, reason: 'ownership-unverifiable', text: null };
    if (st.uid !== resolveUid()) return { ok: false, reason: 'not-operator-owned', text: null };
    if ((st.mode & 0o022) !== 0) return { ok: false, reason: 'insecure-permissions', text: null };

    // Bind the inside-repo decision to the OPENED inode, not just the pathname:
    // realpath the path (resolving any parent symlinks) and confirm it still
    // resolves to the same dev/ino we opened — this defeats a swap between
    // openSync and this check — then prove it is outside the repo tree. Fail
    // closed on any realpath/stat error rather than fall back to a lexical
    // guess that could read an inside-repo file as outside-repo (Codex review
    // MAJOR / TOCTOU).
    let realFile;
    let realRepo;
    let raced;
    try {
      realFile = fs.realpathSync(filePath);
      realRepo = fs.realpathSync(repoRoot);
      const rst = fs.statSync(realFile);
      raced = rst.dev !== st.dev || rst.ino !== st.ino;
    } catch {
      return { ok: false, reason: 'realpath-failed', text: null };
    }
    if (raced) return { ok: false, reason: 'path-race', text: null };
    if (isUnder(realFile, realRepo)) return { ok: false, reason: 'inside-repo', text: null };

    const text = fs.readFileSync(fd, 'utf8');
    return { ok: true, reason: 'ok', text };
  } catch {
    return { ok: false, reason: 'unreadable', text: null };
  } finally {
    try { fs.closeSync(fd); } catch { /* best-effort close */ }
  }
}

// ---------------------------------------------------------------------------
// Separate E1 activation loader
// ---------------------------------------------------------------------------

function normalizeScalar(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

// The separate E1 activation loader (ADR-0041 §2c). Resolves egress channel +
// recipient from the operator environment first, then the verified-ignored-
// local layer — NEVER from the loadNotifyConfig repo/user config.toml path. The
// credential (env-only) is checked for PRESENCE + a leak guard, and never
// returned.
//
// Returns a fail-closed activation descriptor. `active` is true only when a
// known egress channel, a recipient, and a present credential all resolve from
// safe sources, and no resolved scalar collides with the credential value. The
// credential value is never included in the result (§2b); the surfaced `channel`
// is an enum-safe value or null (never an arbitrary/token-shaped string); the
// recipient is surfaced only when active.
export function loadEgressActivation({
  repoRoot = null,
  homeDir = os.homedir(),
  env = process.env,
  getuid,
  readLocalImpl = readVerifiedIgnoredLocal,
} = {}) {
  const localPath = egressLocalConfigPath(homeDir);
  const read = readLocalImpl({ filePath: localPath, repoRoot, getuid });
  const local = read.ok ? parseEgressLocalToml(read.text) : {};
  const localReason = read.reason;

  const envChannel = normalizeScalar(env[EGRESS_ENV_KEYS.channel]);
  const envRecipient = normalizeScalar(env[EGRESS_ENV_KEYS.recipient]);
  const localChannel = normalizeScalar(local[EGRESS_LOCAL_KEYS.channel]);
  const localRecipient = normalizeScalar(local[EGRESS_LOCAL_KEYS.recipient]);

  const channel = envChannel ?? localChannel;
  const recipient = envRecipient ?? localRecipient;
  const channelSource = envChannel ? 'env' : (localChannel ? 'verified-local' : null);
  const recipientSource = envRecipient ? 'env' : (localRecipient ? 'verified-local' : null);

  // The credential value is read locally for a PRESENCE check and a leak guard,
  // and is never placed in the returned descriptor (§2b).
  const credential = normalizeScalar(env[EGRESS_ENV_KEYS.credential]);
  const credentialPresent = credential !== null;
  // If a resolved scalar equals the credential (an operator typo pointing
  // chat-id or channel at TELEGRAM_BOT_TOKEN), refuse to activate — otherwise a
  // returned recipient would echo the token to any downstream log/mirror (Codex
  // review MAJOR / secret handling).
  const credentialCollision = credentialPresent
    && ((channel !== null && channel === credential) || (recipient !== null && recipient === credential));

  let active = false;
  let reason;
  if (credentialCollision) reason = 'credential-collision';
  else if (!channel) reason = 'missing-activation';
  else if (!EGRESS_CHANNELS.includes(channel)) reason = 'unknown-egress-channel';
  else if (!credentialPresent) reason = 'missing-credential';
  else if (!recipient) reason = 'missing-recipient';
  else { active = true; reason = 'active'; }

  return {
    active,
    reason,
    // Echo the channel only when it is an enum-safe value — never an arbitrary
    // (possibly token-shaped) string that a downstream log could leak.
    channel: EGRESS_CHANNELS.includes(channel) ? channel : null,
    recipient: active ? recipient : null,
    credentialPresent,
    channelSource,
    recipientSource,
    source: active ? (channelSource === recipientSource ? channelSource : 'mixed') : null,
    localReason,
  };
}
