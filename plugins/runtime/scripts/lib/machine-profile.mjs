// plugins/runtime/scripts/lib/machine-profile.mjs
//
// The PROFILE ENGINE (machine-bootstrap-contract.md §4) — builds the portable machine
// profile from the §4.4 user-global readers, enforces the §4.3 write-side guards, and
// applies the §4.5 seed-side rules.
//
// THE LOAD-BEARING INVARIANT (§4). The profile is an UNTRUSTED SOURCE OF INTERVIEW
// DEFAULTS. It is never configuration to apply, and it is never an input to any
// activation or config loader. `loadEgressActivation()` MUST NOT read it — a profile
// that could activate egress would be exactly the vector ADR-0041 §2c closed. That is
// why this module only ever RETURNS values; nothing here writes host config, and
// nothing in the activation path imports it (asserted statically, since a runtime
// assertion in a loader nobody calls passes vacuously).
//
// THREE GUARDS, NOT ONE (§4.3). The schema (C4) is the structural layer and cannot
// see a secret, a cross-field implication, or an unsafe posture:
//   1. fail-closed SECRET SCRUB — checked against the ORIGINAL input, before any
//      sanitization. Scrubbing first and checking after is a check that always passes:
//      the sanitizer already removed the thing being looked for. A secret-shaped value
//      REFUSES the write; it is not quietly cleaned up, because a profile that silently
//      dropped a token is one the operator still believes carries their config.
//   2. BOUNDARY validator — every flag false, including performs_network_request, not
//      merely the writes_* trio.
//   3. STATIC loader isolation — tested, not asserted at runtime.
// Secret-pattern matching alone is insufficient (§4.3): it does not remove repository
// paths or an unsafe permission posture. §4.2 and §4.5 carry those.

import { createHash } from 'node:crypto';

import { scrubSecrets } from './egress-channel.mjs';
import { hasCredentialShape, sanitizeValue } from './permission-sanitize.mjs';
import { CONFIG_KEY_FAMILIES, USER_SCOPE_ONLY_CONFIG_KEYS } from './runtime-config.mjs';
import { canonicalize } from './schema-validate.mjs';

export const MACHINE_PROFILE_SCHEMA_VERSION = 'agentic-machine-profile-1.2';
export const EGRESS_CREDENTIAL_ENV_VAR = 'TELEGRAM_BOT_TOKEN';
// ADR-0048 §2.1 — the owner-adopted six-item statusline set, carried in the
// profile as a SCALAR preset id (1.1-additive). The id names a policy; the
// canonical ordered item definition belongs to the statusline adapter.
export const STATUSLINE_PRESET_AGENTIC_6 = 'agentic-6';

// 1.2 — the session-config family (ADR-0044 §3 `session_capture`, ADR-0045 §7
// `entry_brief` / `entry_brief_empty`), carried as TRAILING BARE SCALARS for the
// `statusline_preset` reason: §4.6 forgives an unknown SCALAR from a newer minor
// while an unknown OBJECT is refused at every minor, so a `session` block would make
// every 1.2 profile unreadable to a 1.1 runtime.
//
// DERIVED from the config family, not restated. An earlier version spelled the three
// names out here and justified the literal order as load-bearing for the written
// bytes — which was true at the time and is no longer: `runProfileExport` now
// canonicalizes against the schema before writing, so the SCHEMA alone decides byte
// order and this constant decides MEMBERSHIP. Deriving it removes the second
// membership list a cross-host review flagged, and with it the drift where a fourth
// family member would be read by `projectSession` and silently dropped by the
// builder.
//
// Sorted because the schema declares these three alphabetically, and the schema's
// order IS the canonical order (see lib/schema-validate.mjs). Keeping the two in the
// same order is no longer load-bearing for correctness, but a builder that emitted a
// different order would make every profile need repair on the way out; matching costs
// nothing and keeps the written object canonical before canonicalization touches it.
export const PROFILE_SESSION_KEYS = Object.freeze([...CONFIG_KEY_FAMILIES.session].sort());

// §4.5.3 / ADR-0038 — the postures that are STORED but never PRESENTED as a default.
// The stored enum carries them because §4.5.3 shows a source machine's value as a
// labelled note, and a note needs a field to live in; presentation is where the safety
// rule bites. Keeping the two lists apart is what resolves that apparent contradiction.
export const UNSAFE_CLAUDE_MODES = Object.freeze(['bypassPermissions']);
export const UNSAFE_CODEX_APPROVAL = Object.freeze(['never']);
export const UNSAFE_CODEX_SANDBOX = Object.freeze(['danger-full-access']);

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function field(value, provenance) {
  return { value: value ?? null, scope: 'machine', provenance: value === null || value === undefined ? null : provenance };
}

// §4.2 — the raw hostname never appears; a hash prefix only. Truncated because the
// point is to correlate two profiles from one machine, not to be able to recover the
// name.
export function hashHostname(hostname) {
  return createHash('sha256').update(String(hostname ?? '')).digest('hex').slice(0, 32);
}

/**
 * Build the §4.1 profile from already-read user-global sources. Pure: every input is
 * injected, nothing is probed here, and the result is canonicalized by the caller
 * before hashing/writing.
 *
 * `readers` is the C2 §4.4 bundle — model/effort, notify, Claude permission, Codex
 * permission, egress — each of which read USER-GLOBAL config only. That is a
 * correctness rule, not a preference: the repo-preferring resolvers would promote a
 * project's policy into another machine's global default.
 */
// §4.1 — config keys read by the model/effort reader that the PROFILE does not
// carry. `model_effort_fallback` is a posture declaration, not a coordinate, and
// exporting it would cost more than it gives:
//
//   * every profile member is a `scalarField` OBJECT (`{value, scope,
//     provenance}`), and §4.1 refuses an unknown key carrying an object at EVERY
//     schema minor — so adding it would make every profile this runtime writes
//     unreadable to an older one, breaking the seed path the artifact exists for
//     (measured: `$.model_effort.model_effort_fallback: unknown key carrying
//     object`). Exporting it as a bare scalar instead would put two shapes in one
//     block, which the schema and the builder would both have to special-case.
//   * the profile's model/effort block records what this machine's coordinates
//     ARE. A posture is a decision about what they should be LEFT as, and it is
//     legitimately per-machine: a slower or cheaper machine may want explicit
//     coordinates where this one wants the host's. Seeding it would answer a
//     question the new machine's operator should be asked.
//
// The posture stays observable through `runtime:settings` and judged by
// bootstrap's Stage-4 step; it is not lost, only not propagated.
const PROFILE_EXCLUDED_MODEL_EFFORT_KEYS = Object.freeze(['model_effort_fallback']);

export function buildMachineProfile({ readers, probe, selection, runtimeVersion, hostname, now }) {
  const modelEffort = {};
  for (const key of CONFIG_KEY_FAMILIES.model_effort) {
    if (PROFILE_EXCLUDED_MODEL_EFFORT_KEYS.includes(key)) continue;
    const entry = readers.modelEffort?.keys?.[key];
    modelEffort[key] = field(entry?.value, entry?.provenance);
  }

  const notify = {};
  for (const key of CONFIG_KEY_FAMILIES.notify) {
    const entry = readers.notify?.keys?.[key];
    notify[key] = field(entry?.value, entry?.provenance);
  }

  const egress = readers.egress ?? {};
  // §4.1 — credential_required is true IFF egress was NOT declined AND a channel
  // resolved. A declined egress carries channel: null and credential_required: false.
  // A cross-field implication is not a JSON Schema concept, so it is computed at the
  // one place that knows both facts rather than left for a reader to infer.
  const declined = egress.declined === true || (egress.channel ?? null) === null;
  const channelValue = declined ? null : egress.channel ?? null;

  const claudePerm = readers.claudePermission ?? {};
  const codexPerm = readers.codexPermission ?? {};

  return {
    schema: MACHINE_PROFILE_SCHEMA_VERSION,
    exported_at: new Date(now instanceof Date ? now.getTime() : now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    boundary: {
      writes_host_config: false,
      writes_credential: false,
      writes_config_local_toml: false,
      performs_network_request: false,
    },
    source: {
      hostname_hash: hashHostname(hostname),
      runtime_version: runtimeVersion,
      claude_cli_version: probe?.hosts?.claude?.cli_version ?? null,
      codex_cli_version: probe?.hosts?.codex?.cli_version ?? null,
    },
    selection: {
      bundle: selection.bundle,
      desired: [...(selection.desired ?? [])].sort(),
      excluded: [...(selection.excluded ?? [])].sort(),
      observed: {
        claude: observedFor(probe, 'claude', selection),
        codex: observedFor(probe, 'codex', selection),
      },
    },
    model_effort: modelEffort,
    notify,
    egress: {
      declined,
      channel: field(channelValue, egress.provenance?.channel),
      recipient: field(declined ? null : egress.recipient ?? null, egress.provenance?.recipient),
      headline_opt_in: {
        value: declined ? null : egress.headline ?? null,
        scope: 'machine',
        provenance: declined ? null : egress.provenance?.headline ?? null,
      },
      // The NAME of the variable, never its value (§4.2). The chat-id pre-fills; the
      // token never does (§4.5).
      credential_env_var: EGRESS_CREDENTIAL_ENV_VAR,
      credential_required: !declined && channelValue !== null,
    },
    permissions: {
      claude: {
        // Sanitized per §4.1 — but only AFTER the scrub gate has seen the original
        // (see assertProfileWritable). Sanitizing on the way in would launder a secret
        // past the guard that exists to refuse it.
        allow: (claudePerm.allow ?? []).map((r) => sanitizeValue(r)).filter(Boolean),
        ask: (claudePerm.ask ?? []).map((r) => sanitizeValue(r)).filter(Boolean),
        deny: (claudePerm.deny ?? []).map((r) => sanitizeValue(r)).filter(Boolean),
        defaultMode: claudePerm.default_mode ?? null,
        scope: 'machine',
        provenance: 'user-global',
      },
      codex: {
        approval_policy: codexPerm.approval_policy ?? null,
        sandbox_mode: codexPerm.sandbox_mode ?? null,
        scope: 'machine',
        provenance: 'user-global',
      },
    },
    // 1.1 (ADR-0048 §2.1) — the FIRST of the trailing scalars (schema order =
    // canonical order). It was "serialized LAST" until 1.2 appended the session
    // family after it; what survives the change is the property that mattered —
    // a trailing scalar keeps an older reader's canonical hash aligned with a
    // newer one's over the same document.
    // The reader bundle supplies the preset when BOTH hosts' statusline
    // configuration is observed CANONICAL (owner decision 2026-07-23: the
    // operator applying the rendered agentic-6 fragments IS the declaration);
    // one host, declined, or foreign wiring exports null — never an inference
    // from arbitrary host config.
    statusline_preset: readers.statuslinePreset ?? null,
    // 1.2 — the session family, after `statusline_preset` and in
    // PROFILE_SESSION_KEYS order (see that constant for why the order is
    // alphabetical rather than the family's own). Bare scalars, so unlike every
    // other family here they carry no {scope, provenance} envelope: an object
    // would be refused by a 1.1 reader at any minor, and the envelope would say
    // nothing that varies — this reader is user-global-only by construction, so
    // provenance is user-global exactly when a value is present.
    ...Object.fromEntries(PROFILE_SESSION_KEYS.map((key) => [key, readers.session?.keys?.[key]?.value ?? null])),
  };
}

function observedFor(probe, host, selection) {
  const plugins = probe?.hosts?.[host]?.plugins ?? {};
  return [...new Set(selection.desired ?? [])]
    .sort()
    .filter((name) => name in plugins)
    .map((name) => ({ name, version: plugins[name]?.version ?? null, state: plugins[name]?.state ?? 'unknown' }));
}

// ---------------------------------------------------------------------------
// §4.3 — the write-side guards
// ---------------------------------------------------------------------------

/**
 * Guard 1 — the fail-closed secret scrub, run against the ORIGINAL input.
 *
 * The round-trip is the test: if scrubbing changes anything, something secret-shaped
 * was in there (the `assertNoSecretInArtifact` pattern in lib/egress-launcher-plan.mjs).
 * Returns findings rather than throwing, because a refused export is an operator
 * condition to report, not a crash.
 */
// BOTH detectors, unioned. §4.3 names `scrubSecrets` as the pattern to follow, and it
// is the right precedent — but it is the EGRESS scrub, written for what may leave the
// machine over Telegram, and its own header says so. A profile is not an egress
// payload, and the egress scrub alone misses `password=…`, `github_pat_…`, and long
// hex credentials that `permission-sanitize`'s redactSecrets catches. Using one
// detector because the contract happened to name it, on an artifact it was not written
// for, is following the citation instead of the reason.
function isSecretShaped(text) {
  // The permission-side half is `hasCredentialShape`, NOT `redactSecrets`, and the
  // difference is deliberate. `redactSecrets` also rewrites emails and any 32+ hex
  // run — correct for SANITIZING, wrong for REFUSING. Once this predicate gates a raw
  // source, a permission rule mentioning a git sha or an author address became a hard
  // refusal clearable only by editing host config, while the sanitizer's redaction
  // became unreachable for the very class it exists to clean (code review,
  // reproduced). Credentials refuse; the rest the sanitizer still cleans on the way
  // into the artifact, which is what §4.1 says happens to permission arrays.
  return scrubSecrets(text) !== text || hasCredentialShape(text);
}

// The paths whose value is a hash BY DESIGN. redactSecrets treats any 32+ hex run as a
// credential — reasonable for an arbitrary string, wrong for the field §4.2 REQUIRES to
// be a hash: the hostname is stored hashed precisely so the raw name never travels, and
// flagging that as a leak would refuse every profile ever built. Enumerated by exact
// path, never by shape: "looks like a hash" is what the rule already says, so exempting
// on that basis would exempt everything it exists to catch.
const HASH_BY_DESIGN_PATHS = Object.freeze(new Set(['$.source.hostname_hash']));

function isHashField(path, value) {
  return HASH_BY_DESIGN_PATHS.has(path) && /^[0-9a-f]{16,64}$/.test(value);
}

// §3.2's locator vocabulary: a zero-based `member[n]` ordinal stands in for any
// document-supplied key. Shared by both walks so a finding and the child paths under
// it cannot disagree — truncating one while composing the other from the raw key was
// how the key leaked anyway.
function memberSegment(container, key, flagged) {
  // Only a FLAGGED key becomes an ordinal. §3.2 permits schema-declared property
  // names in a locator, and this walk has no schema to consult — but a key that
  // tripped the secret or path predicate is by construction not one of the profile's
  // declared names (none of them is token- or path-shaped), and it is exactly the
  // key whose content must not be published. Unflagged keys keep their name so
  // `$.permissions.claude.allow[0]` stays the readable locator it needs to be.
  //
  // The residual, stated rather than hidden: a benign but document-supplied unknown
  // key still appears by name. Its content has been tested and found neither secret-
  // nor path-shaped, which is the most this seam can decide without a schema.
  if (!flagged) return key;
  return `member[${Object.keys(container).indexOf(key)}]`;
}

export function findSecretShapedValues(value, path = '$') {
  const findings = [];
  if (typeof value === 'string') {
    if (isSecretShaped(value) && !isHashField(path, value)) findings.push(path);
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => findings.push(...findSecretShapedValues(item, `${path}[${i}]`)));
    return findings;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      // Keys are scanned too: a map keyed by a token is exactly as leaked as one
      // valued by it. The LOCATOR is an ordinal, never the key — §3.2 allows only
      // `$`, schema-declared names, array indices and a `member[n]` standing in for a
      // document-supplied key, and forbids the key name outright. Emitting a
      // truncated key still published the operator's username and repository prefix
      // (code review); the schema validator already uses this convention.
      const flagged = isSecretShaped(key);
      const segment = memberSegment(value, key, flagged);
      if (flagged) findings.push(`${path}.${segment}`);
      findings.push(...findSecretShapedValues(child, `${path}.${segment}`));
    }
  }
  return findings;
}

/**
 * The full write gate: guards 1 and 2 of §4.3, plus the §4.1 cross-field rule and the
 * §4.0 axis separation. Composed with the C4 schema validator by `profileWriteGate`
 * below — structure and meaning are different questions and both must be answered.
 *
 * `original` is the PRE-SANITIZE source (the raw reader output). Passing only the
 * built profile would make the scrub check the sanitizer's own output — a guard
 * inspecting the thing designed to have already removed what it looks for.
 */
export function assertProfileWritable(profile, { original, homeDir = null } = {}) {
  const errors = [];

  // `original` is REQUIRED, and its absence FAILS CLOSED. It was optional, which made
  // the load-bearing half of guard 1 opt-in: a caller who simply omitted it got a scrub
  // that inspected the sanitizer's own output — so a bearer token in a permission rule
  // was quietly laundered to `<redacted>` and exported, instead of refusing. A guard
  // you can forget to pass is a guard that will be forgotten.
  //
  // To validate a profile that HAS no pre-sanitize source (one that arrived from
  // another machine), pass the profile itself: the check is then "is there a secret in
  // this artifact", which is exactly the seed-side question (§4.5.1).
  if (original === undefined) {
    return {
      ok: false,
      errors: [
        'assertProfileWritable requires `original` — the PRE-SANITIZE reader output — so the secret scrub inspects the source rather than the sanitizer’s own output (§4.3 guard 1). Pass the profile itself when validating one that arrived from elsewhere.',
      ],
    };
  }

  // Guard 1 — secrets. Checked in the original AND the profile: the first catches a
  // token the sanitizer would have laundered, the second catches one that reached the
  // artifact by another path.
  // `null` is NOT an escape hatch. Only `undefined` used to be rejected while an
  // explicit `null` skipped the source scan entirely, which is the original
  // laundering defect one argument away — and the tests had normalized passing it
  // (code review, latent). A caller with no pre-sanitize source passes the profile
  // itself, which is what the docstring above already says.
  if (original === null) {
    return { ok: false, errors: ['assertProfileWritable was given `original: null`, which would skip the §4.3 guard-1 source scan entirely. Pass the pre-sanitize source, or the profile itself when validating one that arrived from elsewhere.'] };
  }
  for (const [label, subject] of [['source value', original], ['profile', profile]]) {
    if (subject === null) continue;
    for (const path of findSecretShapedValues(subject)) {
      errors.push(`${label} at ${path} is secret-shaped — refusing to write. A profile carries the credential's env-var NAME and a required boolean, never a value (§4.2/§4.3).`);
    }
  }

  // Guard 2 — the boundary, all four.
  for (const [key, value] of Object.entries(profile?.boundary ?? {})) {
    if (value !== false) errors.push(`boundary.${key} is ${JSON.stringify(value)}; every boundary flag must be false (§4.3 guard 2), performs_network_request included`);
  }
  for (const key of ['writes_host_config', 'writes_credential', 'writes_config_local_toml', 'performs_network_request']) {
    if (!(key in (profile?.boundary ?? {}))) errors.push(`boundary.${key} is absent; the boundary object is part of the schema, not an afterthought`);
  }

  // §4.1 — credential_required IFF not declined AND a channel resolved.
  const egress = profile?.egress ?? {};
  const expectedRequired = egress.declined === false && (egress.channel?.value ?? null) !== null;
  if (egress.credential_required !== expectedRequired) {
    errors.push(`egress.credential_required is ${egress.credential_required} but declined=${egress.declined} and channel=${JSON.stringify(egress.channel?.value ?? null)} imply ${expectedRequired} (§4.1)`);
  }

  // ADR-0048 §4 / D0.4 — the credential env var NAME is a write-gate CONSTANT.
  // The schema shape stays additive (a JSON const would invalidate legal 1.0
  // documents carrying null/other names — §4.6), so the pinning lives here, on
  // every write/seed path: a present name that is not the named E1 variable is
  // an arbitrary-credential channel this contract refuses to record.
  if (egress.credential_env_var !== null && egress.credential_env_var !== undefined && egress.credential_env_var !== EGRESS_CREDENTIAL_ENV_VAR) {
    errors.push(`egress.credential_env_var is ${JSON.stringify(egress.credential_env_var)}; the only credential env var this contract records is ${EGRESS_CREDENTIAL_ENV_VAR} (ADR-0048 §4 — a write-gate constant, kept out of the schema so legal 1.0 documents stay readable)`);
  }
  if (egress.declined === true && (egress.channel?.value ?? null) !== null) {
    errors.push('a declined egress must carry channel: null (§4.1)');
  }

  // §4.0 — the two axes must not be merged. `telegram` is not a notify_channel value
  // and must never become one; egress activation lives on a separate axis precisely so
  // tracked configuration can never activate egress (ADR-0041 §2c).
  const notifyChannel = profile?.notify?.notify_channel?.value ?? null;
  if (notifyChannel !== null && !['none', 'macos-osascript', 'file-log'].includes(notifyChannel)) {
    errors.push(`notify.notify_channel is '${notifyChannel}', which is not a notify channel — an egress channel here would merge the two axes §4.0 keeps apart`);
  }

  // §4.2 — never a repository path. A profile is portable; another machine's checkout
  // layout is neither portable nor any of its business.
  for (const path of findRepositoryPaths(profile, '$', homeDir)) {
    errors.push(`${path} carries a home-directory path — §4.2 excludes repository paths at any nesting depth, because they carry the operator's username and layout into an artifact meant to travel`);
  }

  return { ok: errors.length === 0, errors };
}

// What §4.2 actually excludes is the operator's LAYOUT — a repository path, i.e. a path
// under somebody's home directory, which carries their username and their working
// habits into a file meant to travel. It is not "any path": `Bash(ls /tmp:*)` and
// `/usr/bin/git` say nothing about the operator, and refusing them would refuse
// perfectly ordinary permission rules for no gain.
//
// So the rule is HOME-shaped, at any depth and in any field — no bucket exemption. The
// earlier version skipped allow/ask/deny entirely on the grounds that rules "look
// pathish", which meant `Bash(cd /Users/alice/secret-repo:*)` sailed through the one
// check §4.2 exists for. The generic patterns catch another machine's home too, which
// matters because a profile is precisely the artifact that arrives from elsewhere.
const HOME_PATH_PATTERNS = Object.freeze([
  /(?:^|[\s"'(=:])~\//,                          // ~/...
  /\/(?:Users|home)\/[^/\s"')]+[/\\]/i,          // /Users/alice/... , /home/alice/...
  // `/root` is a home directory with no user segment under it — the generic
  // `/Users|home/<name>/` shape misses it entirely (code review: it was a clean
  // bypass). Bounded so `/rootless` is not a match.
  /(?:^|[\s"'(=:])\/root(?=[/\\]|$)/i,
  // Windows users, with EITHER separator after the name and a name that may contain
  // spaces — `C:\Users\alice/repo/` and `C:\Users\Alice Smith\repo\` both bypassed
  // the original, which required a backslash and rejected spaces.
  /[A-Za-z]:[\\/]Users[\\/][^\\/\n"')]+[\\/]/i,
  /\\\\[^\\\s]+\\Users\\/i,                      // \\host\Users\...
]);

// The predicate, named once so the value walk and the key walk cannot drift into
// asking different questions — which is exactly how the key half went missing.
function isRepositoryPathShaped(text, homeDir) {
  return HOME_PATH_PATTERNS.some((re) => re.test(text)) || containsHomeDir(text, homeDir);
}

// `text.includes(homeDir)` has no path-boundary semantics, so a `/root` home matched
// `/rootless-model` and refused an ordinary value; a very short home is worse (code
// review). A match must end at a separator or at the end of the string — that is what
// makes it a PATH containing the home rather than a string starting with its letters.
function containsHomeDir(text, homeDir) {
  if (!homeDir) return false;
  const home = String(homeDir).replace(/[/\\]+$/, '');
  if (home.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(home, from);
    if (at < 0) return false;
    const next = text[at + home.length];
    if (next === undefined || next === '/' || next === '\\') return true;
    from = at + 1;
  }
}

function findRepositoryPaths(value, path = '$', homeDir = null) {
  const findings = [];
  if (typeof value === 'string') {
    if (isRepositoryPathShaped(value, homeDir)) findings.push(path);
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => findings.push(...findRepositoryPaths(item, `${path}[${i}]`, homeDir)));
    return findings;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      // KEYS are scanned for the same reason `findSecretShapedValues` scans them:
      // §4.2 excludes repository paths "at any nesting depth", and a key IS a nesting
      // position. The secret scanner had this and the path scanner did not, so
      // `{"/Users/alice/private-repo/": "off"}` cleared both the schema and the
      // semantic gate. The locator is an ordinal for the §3.2 reason above — a
      // finding about a leaked path must not itself publish the path.
      const flagged = isRepositoryPathShaped(key, homeDir);
      const segment = memberSegment(value, key, flagged);
      if (flagged) findings.push(`${path}.${segment}`);
      findings.push(...findRepositoryPaths(child, `${path}.${segment}`, homeDir));
    }
  }
  return findings;
}

/**
 * The SUPPORTED write path: structure (C4 schema) + meaning (§4.3 guards), canonical
 * order applied before the bytes are produced.
 *
 * Returns a `validate` function shaped for `writeMachineProfile`'s injected seam, so a
 * caller cannot accidentally wire only the structural half — which was the exact risk
 * C4 flagged when it left the seam open.
 */
export function profileWriteGate({ schemaValidate, original, homeDir = null }) {
  return (profile) => {
    const structural = schemaValidate(profile);
    const semantic = assertProfileWritable(profile, { original, homeDir });
    return {
      ok: structural.ok && semantic.ok,
      errors: [...structural.errors, ...semantic.errors],
      warnings: structural.warnings ?? [],
    };
  };
}

/** Canonical form for writing/hashing (§4.1 — values are canonicalized before hashing). */
export function canonicalProfile(profile, schema) {
  return canonicalize(profile, schema);
}

export function profileHash(profile, schema) {
  return createHash('sha256').update(`${JSON.stringify(canonicalProfile(profile, schema), null, 2)}\n`).digest('hex');
}

// ---------------------------------------------------------------------------
// §4.5 — seed-side
// ---------------------------------------------------------------------------

/**
 * Turn a profile into SEED PROPOSALS (§4.5). Nothing here applies anything: every
 * value comes back as a default REQUIRING CONFIRMATION, safety-graded first.
 *
 * Rule 3 is the one with teeth: a source machine's `bypassPermissions`,
 * `approval_policy: "never"`, or `danger-full-access` MUST NOT be presented as a
 * default. The target's safe recommendation wins and the profile's value is shown as a
 * LABELLED NOTE — "present every value as a default" is subordinate to it (ADR-0038).
 * That is why the stored enum can carry an unsafe posture while this cannot propose it:
 * recording what a machine had and recommending it are different acts.
 */
export function seedProposals({ profile, targetDefaults = {}, validate }) {
  // §4.5.1 — "validate the schema EXACTLY; reject unknown fields, secret-shaped values,
  // and any boundary.writes_* !== false" — BEFORE anything is presented. The profile
  // arrived from another machine and is untrusted by definition; a seed path that read
  // it first and validated never would be reading exactly the artifact an attacker
  // would send. The validator is required, and its absence fails closed rather than
  // defaulting to trust.
  if (typeof validate !== 'function') {
    return {
      ok: false,
      refused: ['seedProposals requires a `validate` function — §4.5.1 validates the incoming profile EXACTLY before any value is presented, and a profile from another machine is untrusted by construction.'],
      proposals: [],
      notes: [],
      boundary: { writes_host_config: false, applies_nothing: true, re_diagnoses_target: true },
    };
  }
  const verdict = validate(profile);
  if (!verdict?.ok) {
    return {
      ok: false,
      refused: verdict?.errors ?? ['the profile failed validation'],
      proposals: [],
      notes: [],
      boundary: { writes_host_config: false, applies_nothing: true, re_diagnoses_target: true },
    };
  }

  const proposals = [];
  const notes = [];

  // The CONFIG key a proposal names, for the scope lookup in `propose`:
  // `session.entry_brief` -> `entry_brief`, `permissions.claude.defaultMode` ->
  // `defaultMode`. The family prefix is presentation; the scope rule is keyed on
  // the config key itself.
  const configKeyOf = (key) => String(key).split('.').pop();

  // §4.5.2 — PRESERVE each value's scope label. Synthesizing `machine` here would
  // promote whatever the incoming file said into a machine-global default — the exact
  // "a repo override is never promoted to machine-global" the rule forbids, performed
  // by the reader rather than by the file.
  const propose = (key, value, entry) => {
    if (value === null || value === undefined) return;
    proposals.push({
      key,
      value,
      scope: entry?.scope ?? null,
      provenance: entry?.provenance ?? null,
      requires_confirmation: true,
      applied: false,
      // 1.2 — DERIVED from this runtime's own key list, never read off `entry`.
      //
      // It was read off `entry` first, and that was forgeable (code review, MEDIUM):
      // for four of the six families `entry` IS an object lifted straight out of the
      // incoming profile, and §4.6 forgives unknown SCALAR keys at any depth when
      // the document declares a newer minor. So a profile claiming schema 1.9 with
      // `model_effort.model.user_scope_only: false` validated cleanly — the
      // validator emitting "unknown scalar key ignored" — while this function read
      // the forged value anyway and put it in the proposal. A trust label the
      // untrusted document can author is worse than no label at all, because a
      // consumer would believe it.
      //
      // Deriving it here also collapses the earlier omitted-vs-false subtlety: the
      // marker is now present on EVERY proposal and is a statement this runtime
      // makes, so there is no "nobody classified this" state left to misread.
      user_scope_only: USER_SCOPE_ONLY_CONFIG_KEYS.includes(configKeyOf(key)),
    });
  };

  for (const [key, entry] of Object.entries(profile.model_effort ?? {})) propose(`model_effort.${key}`, entry.value, entry);
  for (const [key, entry] of Object.entries(profile.notify ?? {})) propose(`notify.${key}`, entry.value, entry);

  // 1.1 (ADR-0048 §2.1) — the statusline preset is a bare scalar (no
  // scope/provenance envelope by design), presented like every other value:
  // a confirmation-required default, never something applied (Codex review
  // MINOR — §4.5's "present every remaining value" covers it).
  propose('statusline_preset', profile.statusline_preset, { scope: 'machine', provenance: 'user-global' });

  // 1.2 — the session family, same bare-scalar treatment. The `session.` prefix
  // matches how `model_effort.` and `notify.` namespace their families, so a
  // consumer reading the proposal list can tell which config family a key belongs
  // to without a lookup table.
  //
  // `entry_brief` and `entry_brief_empty` are USER-SCOPE-ONLY (ADR-0045 §7): they
  // activate a session-shaping injected line, so a repo-tracked value must never be
  // able to enable them, and a seed path that proposed one into a repo target would
  // reintroduce exactly the cloned-repository vector §7 closed. `session_capture` is
  // NOT in that class — a repo value is legitimate for it — so the two must stay
  // distinguishable at the point of use rather than collapsing into one over-broad
  // "session keys are user-only" claim. `propose` derives that distinction from this
  // runtime's own key list; nothing here asserts it.
  for (const key of PROFILE_SESSION_KEYS) {
    propose(`session.${key}`, profile[key], { scope: 'machine', provenance: 'user-global' });
  }

  // The chat-id pre-fills; the token never does (§4.5) — and the token is not in the
  // profile to begin with, so this is the whole of it.
  const egress = profile.egress ?? {};
  if (egress.declined !== true) {
    propose('egress.channel', egress.channel?.value, egress.channel);
    propose('egress.recipient', egress.recipient?.value, egress.recipient);
    propose('egress.headline_opt_in', egress.headline_opt_in?.value, egress.headline_opt_in);
    if (egress.credential_required) {
      notes.push({
        key: 'egress.credential',
        note: `This machine's egress needs ${egress.credential_env_var} in the environment. The profile never carries the token — set it yourself.`,
        labelled: 'credential-required',
      });
    }
  }

  const claude = profile.permissions?.claude ?? {};
  if (UNSAFE_CLAUDE_MODES.includes(claude.defaultMode)) {
    notes.push({
      key: 'permissions.claude.defaultMode',
      note: `The source machine used '${claude.defaultMode}'. Not proposed as a default: the target's safe recommendation wins (§4.5.3, ADR-0038). Shown so the difference is visible, not so it is copied.`,
      labelled: 'unsafe-posture-not-proposed',
      source_value: claude.defaultMode,
      proposed_instead: targetDefaults.claudeDefaultMode ?? null,
    });
  } else {
    propose('permissions.claude.defaultMode', claude.defaultMode, claude);
  }
  for (const bucket of ['allow', 'ask', 'deny']) {
    if ((claude[bucket] ?? []).length > 0) propose(`permissions.claude.${bucket}`, claude[bucket], claude);
  }

  const codex = profile.permissions?.codex ?? {};
  for (const [key, unsafe, targetKey] of [
    ['approval_policy', UNSAFE_CODEX_APPROVAL, 'codexApprovalPolicy'],
    ['sandbox_mode', UNSAFE_CODEX_SANDBOX, 'codexSandboxMode'],
  ]) {
    if (unsafe.includes(codex[key])) {
      notes.push({
        key: `permissions.codex.${key}`,
        note: `The source machine used '${codex[key]}'. Not proposed as a default (§4.5.3, ADR-0038).`,
        labelled: 'unsafe-posture-not-proposed',
        source_value: codex[key],
        proposed_instead: targetDefaults[targetKey] ?? null,
      });
    } else {
      propose(`permissions.codex.${key}`, codex[key], codex);
    }
  }

  return {
    ok: true,
    refused: [],
    proposals,
    notes,
    // §4.5.6 + §4.5.5, stated in the result so a caller rendering it cannot imply
    // otherwise.
    boundary: { writes_host_config: false, applies_nothing: true, re_diagnoses_target: true },
  };
}
