#!/usr/bin/env node
// Syncs the derivable runtime-version tokens in the stage docs to
// .release-please-manifest.json. Idempotent — safe to run any number of
// times; exit 0 with no changes when already in sync.
//
// Why: release-please owns each plugin's per-package manifests, but the
// hand-maintained stage docs restate the shipped runtime version in a
// handful of places. Those restatements are a pure function of the
// manifest, yet every release has required a manual recovery PR to bump
// them (0.86.0 -> #636, 0.86.1 -> #640, 0.86.2 -> #643). Hand-bumping is
// not merely tedious, it is error-producing: #640 left two release
// triples mis-paired (`#630` beside `82cf981` beside
// `plugin-runtime-v0.86.1`, a combination that never existed) because a
// tag token moved and the PR/squash beside it did not. This script is the
// derivation; tests/scripts/test-doc-evidence-consistency.mjs is the
// relation/citation gate that the derivation cannot cover.
//
// Source of truth: .release-please-manifest.json ($.["plugins/runtime"])
//
// TWO TOKEN CLASSES — the distinction is load-bearing:
//
//   shipped-version — true the moment release-please cuts the version
//     ("as of `plugin-runtime` vX it ships ...", the scorecard release
//     tags). Always synced, including from CI, because the claim is about
//     released code and nothing else must happen for it to be true.
//
//   proof-coupled — true only once a `runtime:doctor` proof has actually
//     been re-recorded under the new install ("Latest installed proof",
//     the scorecard's installed-state versions). Synced ONLY when
//     .agentic-plugins/runs/doctor/latest.json reports the manifest
//     version. Writing these without a fresh proof would fabricate
//     evidence, which is exactly the failure ADR-0026 exists to prevent.
//     The refusal is reported, never silent.
//
// WHAT THIS SCRIPT DELIBERATELY DOES NOT DO: rewrite the cited proof run
// ids or dates. Those live in prose alongside superseded historical
// records that are syntactically identical (docs/DEVELOPMENT.md line 459
// packs 25 doctor run ids into one physical line; the scorecard R3 row
// packs 20, and the phrase "re-recorded under the <version> install on
// <date> (<id>" appears five times there — once current, four times
// superseded). The only field separating them is the version number,
// which is the very field a sync would be changing, so the anchor is
// circular. Worse, whether a new release should REPLACE the head record
// or be PREPENDED as a new chain link is an editorial judgment about
// evidence-loop boundaries, not a derivable rule: 0.85.0/0.82.0/0.81.0
// survive as chain links while 0.83.0/0.83.1/0.84.0/0.86.0/0.86.1 were
// absorbed in place, a split that does not follow semver. Corruption
// introduced into those historical records would also be invisible to
// every gate, because superseded tokens are deliberately de-backticked to
// escape the freshness assertions. Citation consistency is therefore
// enforced read-only by the evidence-consistency tests instead.
//
// Usage:
//   node scripts/sync-doc-versions.mjs                  # apply
//   node scripts/sync-doc-versions.mjs --check          # dry-run
//   node scripts/sync-doc-versions.mjs --shipped-only   # skip the
//       proof-coupled class entirely instead of refusing it; for callers
//       that structurally cannot have a recorded proof (the
//       release-please Action runs from a fresh checkout and the artifact
//       tree is gitignored).
//
// Exit codes:
//   0 — sync succeeded (no diffs OR diffs applied)
//   1 — read/parse error, a refused rule, or --check found diffs

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_PATH = '.release-please-manifest.json';
const MANIFEST_KEY = 'plugins/runtime';
const DOCTOR_LATEST_PATH = '.agentic-plugins/runs/doctor/latest.json';

const SEMVER = String.raw`\d+\.\d+\.\d+`;

// Each rule is (file, anchored pattern, class). The anchors are narrow on
// purpose: a bare token pattern would also match superseded records. The
// concrete near-miss this shape guards against — docs/DEVELOPMENT.md line
// 459 carries ten BACKTICKED historical `plugin-runtime-vX` tags
// (0.83.0, 0.81.0, 0.80.1, 0.80.0, 0.79.0, 0.78.1, 0.78.0, 0.77.2,
// 0.77.1), because the de-backticking convention that keeps superseded
// tokens out of the freshness gate applies to the scorecard, which the
// gate reads, and not to DEVELOPMENT.md, which it does not. A repo-wide
// tag rule would have rewritten all ten. Hence: tags are synced in the
// scorecard only.
//
// `capture` splits into [prefix, version, suffix] so replacement never
// has to reconstruct surrounding punctuation.
export const RULES = [
  {
    id: 'architecture-as-of',
    file: 'docs/ARCHITECTURE.md',
    tokenClass: 'shipped-version',
    // "As of" may be hard-wrapped into the next blockquote line in
    // DEVELOPMENT.md ("As of\n> `plugin-runtime` v..."), so the
    // separator alternation carries the blockquote continuation.
    pattern: new RegExp(String.raw`([Aa]s of(?:\n> | )\`plugin-runtime\` v)(${SEMVER})()`, 'g'),
    description: 'authoritative "as of `plugin-runtime` v" shipped-surface statement',
  },
  {
    id: 'development-as-of',
    file: 'docs/DEVELOPMENT.md',
    tokenClass: 'shipped-version',
    pattern: new RegExp(String.raw`([Aa]s of(?:\n> | )\`plugin-runtime\` v)(${SEMVER})()`, 'g'),
    description: 'authoritative "as of `plugin-runtime` v" shipped-surface statement',
  },
  {
    id: 'scorecard-release-tag',
    file: 'docs/assurance/omcc-cutover-scorecard.md',
    tokenClass: 'shipped-version',
    pattern: new RegExp(String.raw`(\`plugin-runtime-v)(${SEMVER})(\`)`, 'g'),
    description: 'current release tag (superseded tags are de-backticked by convention)',
  },
  {
    id: 'scorecard-installed-proof-version',
    file: 'docs/assurance/omcc-cutover-scorecard.md',
    tokenClass: 'proof-coupled',
    pattern: new RegExp(String.raw`(\`plugin-runtime\` \`)(${SEMVER})(\`)`, 'g'),
    description: 'installed-state proof version (superseded versions are de-backticked)',
  },
  {
    id: 'development-latest-installed-proof',
    file: 'docs/DEVELOPMENT.md',
    tokenClass: 'proof-coupled',
    pattern: new RegExp(String.raw`(Latest installed proof: \`plugin-runtime\` \`)(${SEMVER})(\`)`, 'g'),
    description: 'ADR-0012 condition-2 latest installed proof version',
  },
];

function loadJSON(repoRoot, relPath) {
  return JSON.parse(readFileSync(resolve(repoRoot, relPath), 'utf8'));
}

/**
 * Read the recorded doctor proof pointer, if present.
 *
 * The artifact tree is gitignored, so this is absent in CI and on any
 * machine that has not run doctor. Absence is reported, not thrown: the
 * shipped-version class still syncs, and the proof-coupled class refuses
 * with a reason the caller can print.
 *
 * @returns {{present: boolean, runtimeVersion: string|null, runId: string|null, error: string|null}}
 */
export function readDoctorProofPointer(repoRoot) {
  try {
    const latest = loadJSON(repoRoot, DOCTOR_LATEST_PATH);
    return {
      present: true,
      runtimeVersion: typeof latest.runtime_version === 'string' ? latest.runtime_version : null,
      runId: typeof latest.run_id === 'string' ? latest.run_id : null,
      error: null,
    };
  } catch (err) {
    // ENOENT is the ordinary "no local artifacts" case (CI, fresh clone).
    // Anything else — unreadable, malformed — is reported the same way
    // here because both outcomes lead to the same conservative action:
    // refuse to touch proof-coupled tokens. The message distinguishes
    // them for the operator.
    return { present: false, runtimeVersion: null, runId: null, error: err.message };
  }
}

/**
 * Homogeneity precondition.
 *
 * A rule may fire only when its match set is "one lagging value plus, at
 * most, the target value" — i.e. distinct values other than `target`
 * number at most one. A rule whose anchor has stopped being selective
 * (because the docs were restructured, or because a pattern was widened)
 * shows up as a match set spanning several historical versions, and this
 * is where it gets refused instead of rewriting evidence. The allowance
 * for `target` itself is what lets the script repair a half-applied edit
 * rather than deadlocking on it.
 */
export function checkHomogeneity(values, target) {
  const distinctOther = [...new Set(values.filter((v) => v !== target))];
  return { ok: distinctOther.length <= 1, distinctOther };
}

/**
 * Sync the derivable runtime-version tokens in the stage docs to the
 * release-please manifest. Pure function over the filesystem rooted at
 * `repoRoot` so tests can drive it against a temp directory.
 *
 * @param {string} repoRoot — Absolute path to the repository root.
 * @param {{checkOnly?: boolean, shippedOnly?: boolean}} [options]
 * @returns {{
 *   targetVersion: string,
 *   diffs: Array<{rule: string, file: string, tokenClass: string, from: string, to: string, count: number}>,
 *   refusals: Array<{rule: string, file: string, tokenClass: string, reason: string, detail: string}>,
 *   written: string[],
 *   proofPointer: ReturnType<typeof readDoctorProofPointer>,
 * }}
 */
export function syncDocVersionsToManifest(repoRoot, { checkOnly = false, shippedOnly = false } = {}) {
  const manifest = loadJSON(repoRoot, MANIFEST_PATH);
  const targetVersion = manifest[MANIFEST_KEY];
  if (typeof targetVersion !== 'string') {
    throw new Error(`${MANIFEST_PATH} has no string version for "${MANIFEST_KEY}"`);
  }

  const proofPointer = readDoctorProofPointer(repoRoot);
  const proofIsFresh = proofPointer.present && proofPointer.runtimeVersion === targetVersion;

  const diffs = [];
  const refusals = [];
  const written = [];
  // Rules are grouped by file so a file with two rules is read and
  // written once, and so a refusal in one rule cannot half-write the
  // other rule's changes into the same file.
  const byFile = new Map();
  for (const rule of RULES) {
    if (!byFile.has(rule.file)) byFile.set(rule.file, []);
    byFile.get(rule.file).push(rule);
  }

  for (const [file, rules] of byFile) {
    const absPath = resolve(repoRoot, file);
    const original = readFileSync(absPath, 'utf8');
    let next = original;

    for (const rule of rules) {
      const matches = [...original.matchAll(rule.pattern)];

      if (matches.length === 0) {
        // A dead rule is a silent no-op, which is the failure mode that
        // lets docs drift while the sync reports success. Refuse loudly.
        refusals.push({
          rule: rule.id,
          file,
          tokenClass: rule.tokenClass,
          reason: 'anchor-not-found',
          detail: `no occurrence of the ${rule.description} — the rule's anchor no longer matches this document`,
        });
        continue;
      }

      const values = matches.map((m) => m[2]);
      const { ok, distinctOther } = checkHomogeneity(values, targetVersion);
      if (!ok) {
        refusals.push({
          rule: rule.id,
          file,
          tokenClass: rule.tokenClass,
          reason: 'heterogeneous-match-set',
          detail: `matched ${matches.length} token(s) spanning versions ${distinctOther.join(', ')} — the anchor is no longer selective; refusing rather than rewriting possibly-superseded records`,
        });
        continue;
      }

      // `shippedOnly` is for callers that structurally cannot have a
      // recorded proof — the release-please Action runs from a fresh
      // checkout, and the artifact tree is gitignored. There, a
      // proof-coupled refusal is the expected state rather than a
      // problem to report, and silently exiting non-zero on it would
      // make the release workflow red every single time.
      if (rule.tokenClass === 'proof-coupled' && shippedOnly) continue;

      if (rule.tokenClass === 'proof-coupled' && !proofIsFresh) {
        const stale = proofPointer.present
          ? `recorded proof is for ${proofPointer.runtimeVersion ?? 'an unknown version'} (${proofPointer.runId ?? 'no run id'}), manifest is ${targetVersion}`
          : `no recorded doctor proof is readable (${DOCTOR_LATEST_PATH}: ${proofPointer.error})`;
        // Only report the refusal when it would actually change
        // something; an already-correct proof token needs no ceremony.
        if (values.some((v) => v !== targetVersion)) {
          refusals.push({
            rule: rule.id,
            file,
            tokenClass: rule.tokenClass,
            reason: 'proof-not-recorded',
            detail: `${stale}. Re-record with: runtime:doctor --permission-proof --execute-permission-proof --deep-peer-smoke --execute-deep-peer-smoke --workflow-continuation-proof --execute-workflow-continuation-proof --record`,
          });
        }
        continue;
      }

      const outdated = values.filter((v) => v !== targetVersion);
      if (outdated.length === 0) continue;

      next = next.replace(rule.pattern, (whole, prefix, version, suffix) =>
        (version === targetVersion ? whole : `${prefix}${targetVersion}${suffix}`));
      diffs.push({
        rule: rule.id,
        file,
        tokenClass: rule.tokenClass,
        from: outdated[0],
        to: targetVersion,
        count: outdated.length,
      });
    }

    if (next !== original && !checkOnly) {
      writeFileSync(absPath, next);
      written.push(file);
    }
  }

  return { targetVersion, diffs, refusals, written, proofPointer };
}

// CLI entry — only runs when invoked as `node scripts/sync-doc-versions.mjs`.
const invokedAsCLI = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedAsCLI) {
  const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
  const checkOnly = process.argv.includes('--check');
  const shippedOnly = process.argv.includes('--shipped-only');

  try {
    const { targetVersion, diffs, refusals } = syncDocVersionsToManifest(REPO_ROOT, { checkOnly, shippedOnly });

    for (const r of refusals) {
      console.error(`sync-doc-versions: refused ${r.rule} (${r.tokenClass}) in ${r.file} — ${r.reason}`);
      console.error(`  ${r.detail}`);
    }

    if (diffs.length === 0) {
      if (refusals.length === 0) {
        console.log(`OK — stage doc runtime-version tokens already in sync with release-please-manifest (${targetVersion})`);
        process.exit(0);
      }
      process.exit(1);
    }

    if (checkOnly) {
      console.error(`sync-doc-versions: stage doc drift detected (manifest ${targetVersion})`);
      for (const d of diffs) console.error(`  - ${d.file} [${d.rule}]: ${d.from} → ${d.to} (${d.count} token(s))`);
      process.exit(1);
    }

    console.log(`Synced ${diffs.length} stage doc rule(s) to ${targetVersion}:`);
    for (const d of diffs) console.log(`  - ${d.file} [${d.rule}]: ${d.from} → ${d.to} (${d.count} token(s))`);
    process.exit(refusals.length === 0 ? 0 : 1);
  } catch (err) {
    console.error(`sync-doc-versions: ${err.message}`);
    process.exit(1);
  }
}
