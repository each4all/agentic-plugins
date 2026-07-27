#!/usr/bin/env node
// ADR-0049 evidence store gate.
//
// Validates the schema's own shape (every property declares exactly one
// provenance class), every record against that schema, the store's structural
// rules, and the derived fields against git and the release configuration.
// Observed fields are verified only where the doctor artifact still exists;
// the summary reports how many were actually verified so a green run in CI
// cannot be read as more assurance than it is.
//
// An empty store is a pass. The store is forward-only: the schema lands before
// any record exists, and the first live record is authored by the first
// release loop that follows it (ADR-0049 Amendment item 3).

import { checkStore, RECORDS_DIR } from './lib/evidence-store.mjs';

function main() {
  const repoRoot = process.cwd();
  const result = checkStore(repoRoot);

  if (!result.ran) {
    console.error(`evidenceStore: NOT RUN — ${result.reason}`);
    console.error('  A git-backed check that silently no-ops reads as coverage. Failing instead.');
    process.exitCode = 1;
    return;
  }

  const { findings, records, proofStatus, base } = result;
  const proofs = proofStatus.verified + proofStatus.unverified + proofStatus.failed;
  const parts = [`${records} record(s)`, `${findings.length} finding(s)`];
  if (base) parts.push(`reachability base ${base}`);
  if (proofs > 0) {
    parts.push(`proofs ${proofStatus.verified} verified / ${proofStatus.unverified} unverified (artifact absent) / ${proofStatus.failed} failed`);
  }
  console.log(`evidenceStore: ${parts.join(' — ')}`);
  if (records === 0) {
    console.log(`  ${RECORDS_DIR}/ holds no records yet; the store is forward-only.`);
  }

  for (const f of findings) {
    console.error(`  ✗ [${f.check}] ${f.path ?? f.file}: ${f.detail}`);
  }
  if (findings.length > 0) process.exitCode = 1;
}

main();
