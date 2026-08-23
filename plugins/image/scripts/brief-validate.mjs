#!/usr/bin/env node
// plugins/image/scripts/brief-validate.mjs (ADR-0037, ADR-0055)
//
// Validate an ImageBrief's output parameters against gpt-image-2 limits
// (../docs/contracts.md §5) before the brief reaches image:compose. Pure
// functions; the CLI reads a brief JSON and reports issues + warnings.
//
// Generation runs only through Codex's integrated gpt-image — this file
// validates a brief, it does not call any image API.
//
// CLI:
//   node brief-validate.mjs --brief-file <path>
//   stdout: { valid, issues, warnings } as JSON
//   exit 0 if valid, 1 if issues, 2 on misuse.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const QUALITIES = ['low', 'medium', 'high', 'auto'];
const FORMATS = ['png', 'jpeg', 'webp'];
// `transparent` was added by ADR-0055, after the 2026-08-23 probe decoded a
// genuinely transparent PNG out of Codex 0.148.0's integrated tool
// (../docs/transparency-probe.md). ADR-0037 Decision 7's blanket prohibition
// described the direct `gpt-image-2` model, not the installed pair.
export const BACKGROUNDS = ['opaque', 'auto', 'transparent'];
// Transparency is contracted for PNG only. Not because the other formats are
// incapable — WebP plainly is — but because the plugin's whole basis for
// allowing transparency is verifying it in the returned bytes, and it can only
// do that for PNG (contracts.md §5).
export const TRANSPARENT_FORMATS = ['png'];
const MAX_VARIANTS = 8; // cost cap (contracts.md §7)

// Transparent-background *request* patterns, matched INDEPENDENTLY rather than
// as one alternation. A single combined regex let an early, negated candidate
// consume text that a later, un-negated candidate needed: measured on
// "no opaque background; transparent background", where the `background …
// transparent` span swallowed the real request and reported it as negated.
const REQUEST_PATTERNS = [
  /transparent[\s-]+(?:background|bg)\b/gi,
  /\bbackground[^.]{0,24}?transparent/gi,
  /\balpha[\s-]+channel\b/gi,
  /\bsee-through[\s-]+background\b/gi,
];

// Negation is tested against a BOUNDED WINDOW ending at the match, never
// against the whole field.
//
// The original guard was `TRANSPARENT_BG_RE.test(f) && !NEGATED_RE.test(f)`,
// which scanned the entire field — so any negation word anywhere disarmed it.
// The probe demonstrated the hole with its own successful treatment prompt:
// "a fully transparent background with a real alpha channel … No backdrop, no
// white fill" was ADMITTED, because that trailing `No` cleared the guard
// (../docs/transparency-probe.md § Guard defect). Anchoring to the match means
// a negation only counts when it actually governs the phrase it precedes.
//
// The window is a negation token, then at most three intervening words.
// Punctuation bounds it naturally: in "no white fill, transparent background"
// the comma stops the walk, so that phrase reads as a request — correctly.
const NEGATION_BEFORE_RE = /(?:\b(?:no|not|without|avoid|never|excluding|except)\b|\bnon-?|\bun-)\s*(?:\w+[\s-]+){0,3}$/i;

// A preceding window cannot see a negation that sits INSIDE the matched span —
// "background: not transparent" carries its own negation after the word the
// match starts on. Both directions are therefore checked.
const NEGATION_INSIDE_RE = /\b(?:no|not|without|avoid|never|non-?|un-)/i;

/**
 * Does this field ASK for a transparent background?
 * True when at least one candidate is governed by no negation, in either
 * direction. Candidates may overlap; each is judged on its own.
 */
export function isTransparencyRequest(field) {
  if (typeof field !== 'string') return false;
  for (const re of REQUEST_PATTERNS) {
    for (const m of field.matchAll(re)) {
      if (NEGATION_INSIDE_RE.test(m[0])) continue;
      if (NEGATION_BEFORE_RE.test(field.slice(0, m.index))) continue;
      return true;
    }
  }
  return false;
}

export function parseSize(size) {
  if (typeof size !== 'string') return null;
  if (size.trim().toLowerCase() === 'auto') return 'auto';
  const m = size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) return null;
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

export function parseAspect(a) {
  if (typeof a !== 'string') return null;
  const m = a.match(/^(\d+)\s*[:x×]\s*(\d+)$/i);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!w || !h) return null;
  return Math.max(w, h) / Math.min(w, h);
}

export function validateSize(size) {
  const s = parseSize(size);
  if (s === 'auto') return []; // 'auto' is a supported size (contracts.md §5)
  if (!s) return [`size "${size}" is not WxH or 'auto'`];
  const issues = [];
  const { width: w, height: h } = s;
  if (w % 16 !== 0 || h % 16 !== 0) issues.push(`size edges must be multiples of 16 (got ${w}x${h})`);
  const maxEdge = Math.max(w, h);
  const minEdge = Math.min(w, h);
  if (maxEdge > 3840) issues.push(`max edge must be <= 3840 (got ${maxEdge})`);
  if (minEdge > 0 && maxEdge / minEdge > 3.0001) issues.push(`aspect must be <= 3:1 (got ${(maxEdge / minEdge).toFixed(2)}:1)`);
  const total = w * h;
  if (total < 655360 || total > 8294400) issues.push(`total pixels must be 655,360..8,294,400 (got ${total})`);
  return issues;
}

export function validateBrief(brief) {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
    return { valid: false, issues: ['brief must be a JSON object'], warnings: [] };
  }
  const issues = [];
  const warnings = [];

  let out = {};
  if (brief.output != null) {
    if (typeof brief.output !== 'object' || Array.isArray(brief.output)) issues.push('output must be an object');
    else out = brief.output;
  }

  if (out.size != null) issues.push(...validateSize(out.size));

  if (brief.aspect_ratio != null) {
    const ar = parseAspect(brief.aspect_ratio);
    if (ar == null) issues.push(`aspect_ratio "${brief.aspect_ratio}" is not W:H`);
    else if (ar > 3.0001) issues.push(`aspect_ratio must be <= 3:1 (got ${ar.toFixed(2)}:1)`);
  }

  if (out.quality != null && !QUALITIES.includes(out.quality)) issues.push(`output.quality "${out.quality}" not in ${QUALITIES.join('|')}`);
  if (out.format != null && !FORMATS.includes(out.format)) issues.push(`output.format "${out.format}" not in ${FORMATS.join('|')}`);

  const bg = out.background != null ? String(out.background).toLowerCase() : null;
  if (bg != null && !BACKGROUNDS.includes(bg)) {
    issues.push(`output.background "${out.background}" not in ${BACKGROUNDS.join('|')}`);
  }

  // Format policy for transparency (contracts.md §5). Statically decidable, so
  // it is caught here rather than after a paid generation.
  if (bg === 'transparent' && out.format != null && FORMATS.includes(out.format) && !TRANSPARENT_FORMATS.includes(out.format)) {
    issues.push(
      out.format === 'jpeg'
        ? 'output.background "transparent" is incompatible with output.format "jpeg" — JPEG has no alpha channel; use png'
        : 'output.background "transparent" is contracted for png only — webp is alpha-capable, but this plugin cannot inspect webp pixels, so a transparent webp request could never be verified (docs/transparency-probe.md); use png',
    );
  }

  if (out.variants != null) {
    if (!Number.isInteger(out.variants) || out.variants < 1) issues.push('output.variants must be an integer >= 1');
    else if (out.variants > MAX_VARIANTS) issues.push(`output.variants must be <= ${MAX_VARIANTS} (cost cap, contracts.md §7)`);
  }

  if (out.output_compression != null) {
    if (!Number.isInteger(out.output_compression) || out.output_compression < 0 || out.output_compression > 100) {
      issues.push('output.output_compression must be an integer 0..100');
    } else if (out.format != null && !['jpeg', 'webp'].includes(out.format)) {
      warnings.push('output_compression only applies to jpeg/webp');
    }
  }

  // A transparency request in the brief's prose. `output.background` is
  // authoritative; prose that disagrees with it is a contradiction, and prose
  // that asks for something the structured field never recorded cannot be
  // checked against the returned bytes — so it is surfaced either way.
  // `out.background` itself is a validated enum, not prose, so it is not
  // scanned here.
  const textFields = [
    brief.subject, brief.composition, brief.style, brief.palette, brief.background,
    ...(Array.isArray(brief.constraints) ? brief.constraints : []),
  ];
  if (textFields.some((f) => isTransparencyRequest(f))) {
    if (bg === 'opaque') {
      issues.push('the brief text requests a transparent background but output.background is "opaque" — output.background is authoritative, so resolve the contradiction rather than letting the prompt fight the parameter');
    } else if (bg !== 'transparent') {
      warnings.push('the brief text requests a transparent background but output.background is not "transparent" — set it so the request is validated, rendered into the prompt, and recorded in the run manifest (an unrecorded request cannot be checked against the returned bytes)');
    }
  }

  if (out.variants != null && Number.isInteger(out.variants) && out.variants > 1) warnings.push(`output.variants=${out.variants} multiplies cost — disclose + cap before generating (contracts.md §7)`);
  if (!Array.isArray(brief.success_criteria) || brief.success_criteria.length === 0) warnings.push('no success_criteria — image:critique needs them to evaluate the result');

  return { valid: issues.length === 0, issues, warnings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let parsed;
  try {
    parsed = parseArgs({ options: { 'brief-file': { type: 'string' } }, strict: true });
  } catch (err) {
    console.error(`brief-validate: ${err.message}`);
    process.exit(2);
  }
  const f = parsed.values['brief-file'];
  if (!f) { console.error('brief-validate: --brief-file <path> is required'); process.exit(2); }
  let brief;
  try { brief = JSON.parse(readFileSync(f, 'utf8')); } catch (err) {
    console.error(`brief-validate: cannot read/parse brief: ${err.message}`);
    process.exit(2);
  }
  const result = validateBrief(brief);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}
