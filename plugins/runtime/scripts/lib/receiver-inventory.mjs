// receiver-inventory.mjs — classify what is actually INSTALLED at the receiver
// paths, by reading bytes, never by executing them.
//
// WHY THIS EXISTS. The receivers under plugins/runtime/receivers/ are templates
// that the operator renders and installs into ~/.agentic-plugins/bin. Since they
// became delegating shims, behaviour comes from the resolved runtime plugin —
// but WHICH shim is installed still decides whether that delegation happens at
// all. A legacy full copy keeps running its own frozen logic and looks perfectly
// healthy from the outside, so diagnosis has to be able to say which one is
// there.
//
// It must do that WITHOUT running the file. These are user-installed bytes of
// unknown provenance; executing them to ask what they are would be the one thing
// a diagnostic must never do. Everything here is a pure function over one lstat
// and (at most) one bounded read.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// An installed receiver is a rendered template of a few kilobytes. The cap is
// generous enough for any real shape (the largest released one is 9.9 KB) and
// small enough that a hostile or accidental giant file is refused rather than
// read into memory during a diagnostic.
export const RECEIVER_READ_MAX_BYTES = 512 * 1024;

export const RECEIVER_STATES = Object.freeze([
  'current',
  'legacy',
  'foreign',
  'missing',
  'unreadable',
  'not-a-regular-file',
]);

// The placeholder seats the two planners fill, and the ONLY ones.
// `statusline-plan.renderAgenticStatuslineShim` fills the item list and the
// runtime floor; `notification-plan.renderCodexNotifyShuttleScript` the floor;
// `renderCodexNotifyChainScript` the prior argv and the shuttle path.
//
// Each entry pairs the rendered statement with the placeholder it came from and
// the SHAPE the seat must have. The shape matters: normalization identifies a
// file by putting it back into template form, and a seat pattern that accepts
// anything would let edited code be ERASED rather than detected — a file with
// `const STATUSLINE_ITEMS = [globalThis.pwned = true, "x"];` would normalize
// onto the untouched template's hash and be reported as current. So a seat is
// only restored when it contains exactly what the renderer emits: a JSON string
// literal, or a JSON array of them joined by ', ' (the grammar
// `jsStringArrayLiteral` / `jsStringLiteral` produce).
const STRING_LITERAL = String.raw`"(?:[^"\\\n]|\\.)*"`;
const STRING_ARRAY_LITERAL = String.raw`\[(?:${STRING_LITERAL}(?:, ${STRING_LITERAL})*)?\]`;

const SEATS = Object.freeze([
  {
    name: 'STATUSLINE_ITEMS',
    rendered: new RegExp(String.raw`^const STATUSLINE_ITEMS = (${STRING_ARRAY_LITERAL});$`, 'm'),
    placeholder: "const STATUSLINE_ITEMS = ['__AGENTIC_STATUSLINE_ITEMS__'];",
    validate: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
  },
  {
    name: 'MIN_RUNTIME_VERSION',
    rendered: new RegExp(String.raw`^const MIN_RUNTIME_VERSION = (${STRING_LITERAL});$`, 'm'),
    placeholder: "const MIN_RUNTIME_VERSION = '__AGENTIC_MIN_RUNTIME_VERSION__';",
    validate: (value) => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(value),
  },
  {
    name: 'PRIOR_NOTIFY',
    rendered: new RegExp(String.raw`^const PRIOR_NOTIFY = (${STRING_ARRAY_LITERAL});$`, 'm'),
    placeholder: 'const PRIOR_NOTIFY = ["__AGENTIC_PRIOR_NOTIFY__"];',
    validate: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
  },
  {
    name: 'SHUTTLE_PATH',
    rendered: new RegExp(String.raw`^const SHUTTLE_PATH = (${STRING_LITERAL});$`, 'm'),
    placeholder: 'const SHUTTLE_PATH = "__AGENTIC_SHUTTLE_PATH__";',
    validate: (value) => typeof value === 'string' && value.length > 0,
  },
]);

/**
 * Put a rendered receiver back into template form so a template hash can
 * identify which shape it was rendered from.
 *
 * Returns { normalized, seats, rejected }. `rejected` names any seat that was
 * PRESENT but did not hold exactly what the renderer emits — that file is not a
 * faithful render of anything, and the caller must not treat it as one.
 *
 * This is an IDENTIFICATION aid, not an integrity guarantee: it answers "which
 * template shape was this rendered from", and it cannot attest to the rest of
 * the file. What it must not do is let an edited seat pass as an untouched one.
 */
export function normalizeRenderedReceiver(text) {
  let out = String(text);
  const seats = {};
  const rejected = [];
  for (const seat of SEATS) {
    const match = out.match(seat.rendered);
    if (!match) {
      // The seat may legitimately be absent (each receiver carries only its
      // own), or present in a form the renderer never emits. Distinguish them:
      // a bare `const NAME = ` line that did not match the value grammar is a
      // rejection, not an absence.
      if (new RegExp(String.raw`^const ${seat.name} = `, 'm').test(out)) rejected.push(seat.name);
      continue;
    }
    let value;
    try {
      value = JSON.parse(match[1]);
    } catch {
      rejected.push(seat.name);
      continue;
    }
    if (!seat.validate(value)) {
      rejected.push(seat.name);
      continue;
    }
    seats[seat.name] = value;
    out = out.replace(seat.rendered, seat.placeholder);
  }
  return { normalized: out, seats, rejected };
}

function sha256(text) {

  return createHash('sha256').update(text).digest('hex');
}

/**
 * Classify one installed receiver path.
 *
 * `currentTemplateSha` is the sha256 of the CURRENTLY packaged template (the
 * caller renders/reads it — this module does no plugin-relative path
 * resolution). `knownReleasedShapes` maps a released template sha256 to the tag
 * range it shipped in, which is what makes `legacy` distinguishable from
 * `foreign`: without it both would collapse to "not current" and the operator
 * could not tell an out-of-date install from someone else's file.
 */
export function classifyInstalledReceiver({
  kind,
  path,
  pointer = path,
  currentTemplateSha = null,
  knownReleasedShapes = {},
  readFile = readFileSync,
  lstat = lstatSync,
  maxBytes = RECEIVER_READ_MAX_BYTES,
} = {}) {
  const base = { kind, path_pointer: pointer, bytes: null, sha256: null, normalized_sha256: null, marker: null, shipped_in: null };

  let stat;
  try {
    // lstat, never stat: a symlink must be REPORTED, never silently followed to
    // whatever it points at. Following it would let the classifier certify a
    // target it never names.
    stat = lstat(path);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { ...base, state: 'missing', detail: 'No file is installed at this path.' };
    }
    return { ...base, state: 'unreadable', detail: `The path could not be inspected (${error?.code ?? 'unknown error'}).` };
  }

  if (stat.isSymbolicLink()) {
    return {
      ...base,
      state: 'not-a-regular-file',
      detail: 'The installed path is a symlink. Its target is deliberately not followed or classified — report only.',
    };
  }
  if (!stat.isFile()) {
    return { ...base, state: 'not-a-regular-file', detail: 'The installed path is not a regular file.' };
  }
  if (stat.size > maxBytes) {
    return {
      ...base,
      bytes: stat.size,
      state: 'unreadable',
      detail: `The installed file is ${stat.size} bytes, over the ${maxBytes}-byte inspection cap; it is not read.`,
    };
  }

  let buffer;
  try {
    buffer = readFile(path);
  } catch (error) {
    return { ...base, bytes: stat.size, state: 'unreadable', detail: `The installed file could not be read (${error?.code ?? 'unknown error'}).` };
  }

  // Hash the BYTES, not a decoded string: two files differing only in an
  // invalid UTF-8 sequence decode to the same replacement characters and would
  // certify as identical (the reason recorded in ADR-0051 for the artifact
  // hashes). Decoding happens separately, for the text-shaped checks below.
  const raw = createHash('sha256').update(buffer).digest('hex');
  const text = buffer.toString('utf8');
  const { normalized: normalizedText, rejected } = normalizeRenderedReceiver(text);
  const normalized = sha256(normalizedText);
  const markerMatch = text.match(/^\/\/ @agentic-receiver: (.{1,120})$/m);
  const marker = markerMatch ? markerMatch[1].trim() : null;
  const facts = { ...base, bytes: stat.size, sha256: raw, normalized_sha256: normalized, marker };

  // A seat that is present but does not hold what the renderer emits means the
  // file was edited where a rendered value belongs. Reporting it by hash would
  // be exactly the evasion normalization must not enable, so it is `foreign`
  // regardless of what the rest of the bytes match.
  if (rejected.length > 0) {
    return {
      ...facts,
      state: 'foreign',
      detail: `The installed file holds something other than a rendered value at ${rejected.join(', ')}; it is not a faithful render of any template.`,
    };
  }

  if (currentTemplateSha && normalized === currentTemplateSha) {
    return { ...facts, state: 'current', detail: 'The installed file matches the currently packaged template.' };
  }
  const shipped = knownReleasedShapes[normalized];
  if (shipped) {
    return {
      ...facts,
      shipped_in: shipped,
      state: 'legacy',
      detail: `The installed file is a previously released shape (${shipped}); re-install to pick up the current one.`,
    };
  }
  return {
    ...facts,
    state: 'foreign',
    detail: 'The installed file matches neither the current template nor any released shape — it was edited, hand-written, or produced by another tool.',
  };
}

/**
 * True when the state warrants offering a re-install.
 *
 * `missing` counts only for a receiver the operator actually opted into. Every
 * receiver here is opt-in — the statusline shim is installed only if the
 * operator adopted it, and the chain receiver ONLY exists when a prior notifier
 * had to be preserved (direct mode never installs one). Treating any absence as
 * something to fix would tell most machines to install a file they deliberately
 * do not have.
 */
export function receiverNeedsReinstall(state, { expected = false } = {}) {
  if (state === 'legacy') return true;
  return state === 'missing' && expected === true;
}

/**
 * Roll one classification set up into a single readiness word, worst-first.
 *
 * `foreign` / `not-a-regular-file` are NOT rolled up as "just re-install":
 * overwriting a file the operator deliberately put there is their decision, not
 * a diagnosis's. An absent opt-in receiver is not a defect at all, so it does
 * not degrade the roll-up.
 */
export function rollUpReceiverStates(entries) {
  const states = entries.map((entry) => entry.state);
  if (states.includes('foreign') || states.includes('not-a-regular-file') || states.includes('unreadable')) return 'attention';
  if (states.includes('legacy')) return 'stale';
  if (entries.some((entry) => entry.state === 'missing' && entry.expected === true)) return 'incomplete';
  return 'current';
}


// ---------------------------------------------------------------------------
// The packaged view: what SHOULD be installed, and what IS
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASED_SHAPES_POINTER = 'data/released-receiver-shapes.json';

// The three installable receivers. Each names the packaged template it is
// rendered from and the basename it is installed under (they are the same
// name — the install is a rendered copy, not a rename).
export const RECEIVER_KINDS = Object.freeze([
  'agentic-statusline.mjs',
  'codex-notify-shuttle.mjs',
  'codex-notify-chain.mjs',
]);

function readPackaged(relativePath) {
  return readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8');
}

/** The released-shape registry, or an empty registry if it cannot be read. */
export function loadReleasedReceiverShapes({ read = readPackaged } = {}) {
  try {
    const parsed = JSON.parse(read(RELEASED_SHAPES_POINTER));
    return parsed && typeof parsed.shapes === 'object' && parsed.shapes !== null ? parsed.shapes : {};
  } catch {
    // Fail SOFT, and visibly: with no registry every non-current install reads
    // as `foreign` rather than `legacy`. That over-reports rather than
    // under-reports, which is the safe direction for a diagnostic.
    return {};
  }
}

/**
 * Classify all three receivers under one install directory.
 *
 * Read-only and execution-free by construction — it reaches
 * `classifyInstalledReceiver`, which does one lstat and at most one bounded
 * read per path.
 */
export function inspectInstalledReceivers({
  installDir,
  pointerDir = '~/.agentic-plugins/bin',
  read = readPackaged,
  // Which receivers this machine actually opted into. Absence of anything NOT
  // listed here is reported as a fact and nothing more — see
  // receiverNeedsReinstall. The caller knows this (it reads the host config);
  // the classifier deliberately does not guess.
  expected = [],
  ...overrides
} = {}) {
  const shapes = loadReleasedReceiverShapes({ read });
  const expectedSet = new Set(expected);
  const entries = RECEIVER_KINDS.map((kind) => {
    let currentTemplateSha = null;
    try {
      currentTemplateSha = sha256(read(`receivers/${kind}`));
    } catch {
      // A missing packaged template means we cannot say "current"; every
      // install then falls through to legacy/foreign, never to a false current.
      currentTemplateSha = null;
    }
    const classified = classifyInstalledReceiver({
      kind,
      path: join(installDir, kind),
      pointer: `${pointerDir}/${kind}`,
      currentTemplateSha,
      knownReleasedShapes: shapes[kind] ?? {},
      ...overrides,
    });
    const isExpected = expectedSet.has(kind);
    return {
      ...classified,
      expected: isExpected,
      // An absent opt-in receiver reads as `not-installed`, which is a fact
      // about this machine rather than a defect in it.
      detail: classified.state === 'missing' && !isExpected
        ? 'No file is installed at this path, and this receiver is not one this machine opted into.'
        : classified.detail,
    };
  });
  return {
    install_dir_pointer: pointerDir,
    state: rollUpReceiverStates(entries),
    reinstall_recommended: entries.some((entry) => receiverNeedsReinstall(entry.state, { expected: entry.expected })),
    receivers: entries,
    limits: receiverInventoryLimits(),
  };
}

export function receiverInventoryLimits() {
  return [
    'Installed receivers are classified by READING their bytes; they are never imported, spawned, or evaluated.',
    'A symlinked install path is reported as such and its target is not followed or classified.',
    'Classification identifies which template shape a file was rendered from; it is not an integrity or authenticity guarantee.',
    'Re-installing is the operator\'s action — this inventory never writes to the install directory.',
  ];
}

/**
 * The operator-facing step for an inventory that warrants one.
 *
 * Deliberately a PLAN, never an action: runtime does not write into the install
 * directory (ADR-0048 §2 — the plan renders, the operator installs). Returns
 * null when nothing is worth offering, so a healthy machine gets no nag.
 */
export function buildReceiverReinstallStep(inventory, { host = 'neutral' } = {}) {
  const actionable = inventory.receivers.filter((entry) => receiverNeedsReinstall(entry.state, { expected: entry.expected }));
  const blocked = inventory.receivers.filter(
    (entry) => entry.state === 'foreign' || entry.state === 'not-a-regular-file' || entry.state === 'unreadable',
  );
  if (actionable.length === 0 && blocked.length === 0) return null;

  const command = host === 'codex' ? '$runtime:settings' : '/runtime:settings';
  const step = {
    state: inventory.state,
    // What the operator should do, and for which files — never a bare "re-install".
    reinstall: actionable.map((entry) => ({
      kind: entry.kind,
      pointer: entry.path_pointer,
      observed: entry.state,
      shipped_in: entry.shipped_in,
      action: entry.state === 'missing'
        ? `Render and install ${entry.kind} from the plan artifact.`
        : `Back up ${entry.path_pointer}, then install the newly rendered ${entry.kind} over it.`,
    })),
    // A file runtime did not render is the operator's; naming it is the whole
    // service, overwriting it is not.
    manual_review: blocked.map((entry) => ({
      kind: entry.kind,
      pointer: entry.path_pointer,
      observed: entry.state,
      action: 'Inspect this path yourself; runtime does not overwrite a file it did not render.',
    })),
    rollback: buildReceiverRollbackGuidance(actionable),
    presented_command: `${command} --notification-plan`,
  };
  return step;
}

/**
 * How to get BACK, stated precisely — because after the delegating-shim change
 * the obvious rollback no longer does what it used to.
 */
export function buildReceiverRollbackGuidance(entries) {
  const guidance = [
    'Back up the installed file before overwriting it; the backup is the rollback.',
  ];
  if (entries.some((entry) => entry.state === 'legacy')) {
    guidance.push(
      'The file being replaced is a SELF-CONTAINED copy: restoring that backup fully reverts behaviour, because everything it rendered lived inside it.',
      'The replacement is a DELEGATING shim, and restoring a backup of one does NOT revert behaviour — a delegating shim renders through whichever runtime plugin resolves at the time. Rolling that back means rolling the runtime plugin back too, to a version at or above the shim\'s rendered floor.',
    );
  }
  return guidance;
}
