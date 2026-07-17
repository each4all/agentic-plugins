// plugins/runtime/scripts/lib/permission-usage-sources.mjs
//
// Usage-record enumeration for the ADR-0038 permission family — the read half that
// feeds both runtime:doctor's R0 diagnosis and runtime:settings' M1 plan.
//
// Lifted out of scripts/doctor.mjs (machine-bootstrap-contract.md §1.3). The rest of
// the permission family — the learner, the advisor core, the artifact constructor, the
// host-config readers, the sanitizer — already lives in lib/; this enumerator was the
// last member still parked in doctor.mjs, which meant a planner that wanted only the
// scan had to import the whole host-CLI diagnostic module. §1.1 forbids the bootstrap
// chain from inheriting that reach ("the reads still happen, and any future consumer of
// the filtered report re-inherits them"), so the enumerator moves to this leaf instead
// of being injected past it: injection would leave doctor.mjs the reader's home and make
// every future lib consumer wire a seam around it.
//
// Closure is deliberately shallow — node builtins plus state-readers' canonical
// $CODEX_HOME resolution. Nothing here reaches a host CLI or spawns a process.

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveCodexHome } from './state-readers.mjs';

// Per-host scan budget. Also surfaced verbatim in runtime:doctor's operator-visible
// limits text, so it is exported rather than duplicated at the call site.
export const PERMISSION_DIAGNOSIS_MAX_SCAN = 20000;

// Recursively collect record files under `dir` whose basename matches `matchFn`,
// read-only and NO-FOLLOW: lstat `current` itself first so a symlinked record
// ROOT (e.g. a symlinked ~/.claude/projects) is never followed (Plan-verify peer
// MAJOR), entry symlinks are skipped, every fs error is degraded to "no record
// here" (never thrown). Files larger than `maxFileBytes` are skipped + counted so
// one giant transcript cannot spike doctor's memory (Plan-verify peer MINOR).
// Bounded by a per-call scan budget + depth cap. Returns
// { files: [{ path, mtimeMs }], skippedTooLarge, scanTruncated }.
async function collectRecordFiles(dir, matchFn, budget, maxFileBytes) {
  const files = [];
  let skippedTooLarge = 0;
  async function walk(current, depth) {
    if (budget.scanned >= budget.maxScan || depth > 8) return;
    let dirInfo;
    try {
      dirInfo = await lstat(current);
    } catch {
      return;
    }
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget.scanned >= budget.maxScan) return;
      budget.scanned += 1;
      const full = join(current, entry.name);
      let info;
      try {
        info = await lstat(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(full, depth + 1);
      } else if (info.isFile() && matchFn(entry.name)) {
        if (maxFileBytes && info.size > maxFileBytes) {
          skippedTooLarge += 1;
          continue;
        }
        files.push({ path: full, mtimeMs: info.mtimeMs });
      }
    }
  }
  await walk(dir, 0);
  return { files, skippedTooLarge, scanTruncated: budget.scanned >= budget.maxScan };
}

// Enumerate Claude transcripts (~/.claude/projects/**/*.jsonl) and Codex rollouts
// ($CODEX_HOME|~/.codex/sessions/**/rollout-*.jsonl), most-recent-first, capped to
// `maxFiles` per host. Each host gets an INDEPENDENT scan budget so a large Claude
// tree cannot starve the Codex scan and misreport it as empty (Plan-verify peer
// MAJOR). Read-only; reports found/used/scan_truncated/skipped_too_large per host
// so a cap is never silent. Shared so runtime:doctor and runtime:settings reuse the
// same hardened (no-follow, budgeted, byte-capped) enumeration instead of
// duplicating it.
export async function collectUsageRecordSources({ homeDir, env, maxFiles, maxFileBytes }) {
  const claudeDir = join(homeDir, '.claude', 'projects');
  const codexHome = resolveCodexHome(env, homeDir);
  const codexDir = join(codexHome, 'sessions');

  const claude = await collectRecordFiles(
    claudeDir, (n) => n.endsWith('.jsonl'),
    { scanned: 0, maxScan: PERMISSION_DIAGNOSIS_MAX_SCAN }, maxFileBytes,
  );
  const codex = await collectRecordFiles(
    codexDir, (n) => /^rollout-.*\.jsonl$/.test(n),
    { scanned: 0, maxScan: PERMISSION_DIAGNOSIS_MAX_SCAN }, maxFileBytes,
  );

  const pick = (list) => list.slice().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(0, maxFiles));
  const claudePicked = pick(claude.files);
  const codexPicked = pick(codex.files);
  const hostReport = (res, picked) => ({
    found: res.files.length,
    used: picked.length,
    scan_truncated: res.scanTruncated,
    skipped_too_large: res.skippedTooLarge,
  });

  return {
    sources: [
      ...claudePicked.map((f) => ({ path: f.path, host: 'claude' })),
      ...codexPicked.map((f) => ({ path: f.path, host: 'codex' })),
    ],
    scanned: {
      claude: hostReport(claude, claudePicked),
      codex: hostReport(codex, codexPicked),
    },
    capped: claude.files.length > claudePicked.length || codex.files.length > codexPicked.length,
  };
}
