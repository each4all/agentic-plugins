// Session-capture file inspection core, runtime-internal.
//
// Moved out of context.mjs so lib/entry-brief-readers.mjs (ADR-0045 S7a) can
// validate entry.json without importing context.mjs — context.mjs will import
// the entry-brief readers for the S7b arbiter, so the reverse import would
// form a cycle. context.mjs re-imports everything here rather than keeping
// private copies: the fail-closed gate sequence (lstat no-follow → symlink →
// regular-file → size → read → parse → schema → sanitized reason → semantic)
// is a security contract (session-capture-contract.md §3/§10) and must never
// fork into two drifting mirrors.
// Runtime-internal import only — the ADR-0010 §5 import ban is cross-plugin.

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadSchema, validateAgainstSchema } from './schema-validate.mjs';

export const SESSION_CAPTURE_SEGMENTS = Object.freeze(['state', 'runtime', 'session-capture']);
export const SESSION_CAPTURE_FILE_FAMILIES = Object.freeze({
  'slot.json': 'runtime-session-capture',
  'entry.json': 'runtime-session-entry',
  'note.json': 'runtime-session-note',
});
export const NOTE_CONTENT_MAX_BYTES = 4096; // contract §4 — writer-enforced UTF-8 BYTES (schema maxLength is a codepoint backstop)
export const CAPTURE_FILE_MAX_BYTES = 256 * 1024; // read bound before JSON.parse — the schema's 64 KiB cap runs after a full read
export const REASON_LINE_CAP = 200;

export function sessionCaptureDir(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', ...SESSION_CAPTURE_SEGMENTS);
}

export function truncateReason(reason) {
  // Control characters (C0 + DEL + C1) are stripped, not just whitespace-
  // folded: reasons can quote hostile file content and must never carry
  // terminal-control bytes into a report or a stderr line.
  const text = String(reason ?? 'unknown')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > REASON_LINE_CAP ? `${text.slice(0, REASON_LINE_CAP)}…` : text;
}

export function sanitizeValidationReason(errors) {
  const paths = [];
  for (const error of errors) {
    const m = /^([^:]{1,120}):/.exec(String(error));
    paths.push(m ? m[1] : 'document');
  }
  const unique = [...new Set(paths)];
  const shown = unique.slice(0, 5);
  const more = unique.length > shown.length ? ` (+${unique.length - shown.length} more)` : '';
  return truncateReason(`schema validation failed at ${shown.join(', ')}${more}`);
}

// Contract §11 — the semantic invariants structural JSON Schema cannot
// express, enforced by every inspection consumer for every family it reads.
// A violation is a fail-closed skip exactly like a schema violation.
export function semanticCaptureViolation(fileName, document) {
  if (fileName === 'note.json') return noteShapeViolation(document);
  if (fileName === 'slot.json') {
    if (document.summary_source === 'structural' && document.note !== null) {
      return 'summary_source=structural requires note=null';
    }
    if (document.summary_source === 'staged-note' && document.note === null) {
      return 'summary_source=staged-note requires a folded note';
    }
    const dirty = dirtyCountViolation(document.dirty_count);
    if (dirty) return dirty;
    if (document.note !== null) {
      const folded = noteShapeViolation(document.note);
      if (folded) return `folded note: ${folded}`;
    }
    return null;
  }
  if (fileName === 'entry.json') {
    if (document.summary_source === 'structural' && (document.summary_line !== null || document.note_staged_at !== null)) {
      return 'summary_source=structural requires summary_line and note_staged_at to be null';
    }
    if (document.summary_source === 'staged-note' && (document.summary_line === null || document.note_staged_at === null)) {
      return 'summary_source=staged-note requires summary_line and note_staged_at (contract §11 biconditional)';
    }
    return dirtyCountViolation(document.dirty_count);
  }
  return null;
}

function dirtyCountViolation(value) {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    return 'dirty_count must be a non-negative integer when non-null';
  }
  return null;
}

// Shared between note.json and slot.json's folded note — one checker for
// both copies of the note shape, so a cap/hash rule fix can never land on
// only one of the two mirrors.
function noteShapeViolation(note) {
  const bytes = Buffer.byteLength(note.content, 'utf8');
  if (bytes === 0) return 'content must not be empty';
  if (bytes > NOTE_CONTENT_MAX_BYTES) {
    return `content is ${bytes} UTF-8 bytes, over the ${NOTE_CONTENT_MAX_BYTES}-byte cap`;
  }
  const expected = `sha256:${createHash('sha256').update(Buffer.from(note.content, 'utf8')).digest('hex')}`;
  if (note.content_hash !== expected) return 'content_hash does not match the content bytes';
  return null;
}

// Read one session-capture file: absent | valid | invalid. Fail-closed per
// file (contract §3/§10): a malformed file is skipped with a one-line reason
// and its fields are NOT exposed; it is never repaired or deleted on read.
// The caller layers pointers/summaries on top — this core stays presentation-
// free so both context.mjs (status --slot) and the entry-brief readers share
// one gate sequence.
export async function inspectSessionCaptureFileCore({ dir, fileName, family }) {
  const filePath = resolve(dir, fileName);
  const base = { state: 'absent', reason: null, document: null };
  // lstat no-follow gates BEFORE the read: a symlinked artifact file, a
  // non-regular entry, or an oversized file is skipped fail-closed without
  // reading it (the consumer never follows links and never slurps unbounded
  // bytes ahead of the validator's post-parse cap).
  let entryStat;
  try {
    entryStat = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return base;
    return { ...base, state: 'invalid', reason: truncateReason(`unreadable: ${error?.code ?? error?.message ?? 'unknown'}`) };
  }
  if (entryStat.isSymbolicLink()) {
    return { ...base, state: 'invalid', reason: 'symlinked artifact file refused (lstat no-follow)' };
  }
  if (!entryStat.isFile()) {
    return { ...base, state: 'invalid', reason: 'not a regular file' };
  }
  if (entryStat.size > CAPTURE_FILE_MAX_BYTES) {
    return { ...base, state: 'invalid', reason: `file is ${entryStat.size} bytes, over the ${CAPTURE_FILE_MAX_BYTES}-byte read bound` };
  }
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    return { ...base, state: 'invalid', reason: truncateReason(`unreadable: ${error?.code ?? error?.message ?? 'unknown'}`) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...base, state: 'invalid', reason: 'not valid JSON' };
  }
  let verdict;
  try {
    const schema = await loadSchema(family);
    verdict = validateAgainstSchema(parsed, schema, { readerVersion: schema.$id });
  } catch (error) {
    return { ...base, state: 'invalid', reason: truncateReason(`schema load failed: ${error?.message ?? 'unknown'}`) };
  }
  if (!verdict.ok) {
    // Sanitized reason: field paths only, never the validator's value
    // quotations — a rejected string is untrusted data and must not flow
    // into the report through its own rejection message.
    return { ...base, state: 'invalid', reason: sanitizeValidationReason(verdict.errors) };
  }
  const semantic = semanticCaptureViolation(fileName, parsed);
  if (semantic) {
    return { ...base, state: 'invalid', reason: truncateReason(`semantic invariant violated: ${semantic}`) };
  }
  return { ...base, state: 'valid', document: parsed };
}
