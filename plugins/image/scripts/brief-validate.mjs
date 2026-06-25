#!/usr/bin/env node
// plugins/image/scripts/brief-validate.mjs (ADR-0037)
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
const BACKGROUNDS = ['opaque', 'auto']; // gpt-image-2: no transparent (contracts.md §5)
const MAX_VARIANTS = 8; // cost cap (contracts.md §7)

// "transparent background" detection: a background fourcc/medium adjective like
// "transparent watercolor" is NOT a transparent background; a negated mention
// ("avoid/no/without transparent") is a constraint, not a request.
const TRANSPARENT_BG_RE = /transparent\s+(?:background|bg)|background[^.]{0,12}transparent|\balpha\s+channel\b|\bsee-through\s+background\b/i;
const NEGATED_RE = /\b(?:no|not|without|avoid|never|non-?transparent|opaque)\b/i;

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
  if (out.background != null && !BACKGROUNDS.includes(String(out.background).toLowerCase())) {
    issues.push(`output.background "${out.background}" not in opaque|auto (gpt-image-2 has no transparent-background support)`);
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

  // transparent-background request anywhere in the brief's text fields
  const textFields = [brief.subject, brief.composition, brief.style, brief.palette, brief.background, out.background, ...(Array.isArray(brief.constraints) ? brief.constraints : [])].filter((v) => typeof v === 'string');
  for (const f of textFields) {
    if (TRANSPARENT_BG_RE.test(f) && !NEGATED_RE.test(f)) {
      issues.push('transparent background is unsupported by gpt-image-2 — use opaque/auto (ADR-0037 Decision 7); do not promise it via prompt wording');
      break;
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
