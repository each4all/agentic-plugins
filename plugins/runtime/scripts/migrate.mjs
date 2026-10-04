#!/usr/bin/env node
// plugins/runtime/scripts/migrate.mjs
//
// The `runtime:migrate` dispatcher. One subcommand:
//
//   workflow-storage        ADR-0025 legacy .claude/agentic-* → .agentic-plugins/state.
//                           Dry-run by default; mutates only with --apply.
//
// `legacy-egress-intents`, the read-only cross-checkout discovery of
// pre-upgrade egress intent WALs (ADR-0048 residual (d)), was removed with the
// egress subsystem (ADR-0064 Decision 1). Its name is still recognised so it is
// refused by name, never routed to workflow-storage by default.
//
// WHY THE SUBCOMMAND IS FOUND BY SEARCH, NOT BY POSITION.
//
// `commands/migrate.md` invokes this as
//
//     node .../migrate.mjs --repo-root "$REPO_ROOT" $ARGUMENTS
//
// so `--repo-root` arrives BEFORE anything the operator typed. The obvious
// dispatcher shape — `opts.command = argv.shift()`, which is what
// `retention.mjs` does — would read `--repo-root` as the subcommand and fail
// every invocation. `retention.md` can use that shape because it does not
// pre-place a flag; this command does.
//
// So the subcommand is the first argv element that is a known subcommand NAME,
// skipping any element consumed as a value by a preceding flag. That last part
// is not decoration: without it, `--repo-root workflow-storage` (a directory
// that happens to be called that) would be silently eaten as the subcommand and
// the real repo root lost.
//
// The workflow-storage implementation is NOT re-implemented here. It is
// imported from `migrate-workflow-storage.mjs`, which also keeps its own entry
// point so the direct path that shipped in earlier versions still works. One
// help surface, one exit-code rule, one argv contract.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeOperatorText } from './lib/operator-text.mjs';
import { ArgsFileError, expandArgsFile } from './lib/args-file.mjs';

// The workflow-storage half — the M1 MUTATOR, which imports node:child_process
// at module scope — is loaded DYNAMICALLY, inside the branch that routes to it,
// so a refusal (a retired subcommand, an ambiguous argv) never evaluates the
// mutating module. A literal dynamic specifier keeps the executor-guard's
// import analysis intact.

export const MIGRATE_SUBCOMMANDS = Object.freeze(['workflow-storage']);
const DEFAULT_SUBCOMMAND = 'workflow-storage';

// Subcommands a release removed, with the decision that removed each. They are
// recognised by the dispatcher so they are refused BY NAME: left unknown, the
// name would fall through to the default subcommand's parser.
export const RETIRED_MIGRATE_SUBCOMMANDS = Object.freeze({
  'legacy-egress-intents': 'ADR-0064',
});

// Every flag that consumes the NEXT argv element as its value. The dispatcher
// must know it before it knows which subcommand it is routing to.
const VALUE_FLAGS = new Set(['--repo-root', '--format', '--plugin']);

// Split argv into { subcommand, rest }. The subcommand is removed; everything
// else is forwarded untouched, in order.
export function splitSubcommand(argv) {
  const known = new Set([...MIGRATE_SUBCOMMANDS, ...Object.keys(RETIRED_MIGRATE_SUBCOMMANDS)]);
  const rest = [];
  let subcommand = null;
  // A subcommand NAME that was eaten as a flag's value. Legitimate when a
  // directory is really called that; a typo when the operator dropped the flag's
  // value (`--repo-root workflow-storage --apply` silently becomes a
  // workflow-storage APPLY against a repo root that does not exist). The two are
  // indistinguishable from argv, so the caller refuses and asks — see below.
  const consumedAsValue = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (subcommand === null && known.has(arg)) {
      subcommand = arg;
      continue;
    }
    rest.push(arg);
    // `--flag value` consumes the next element; `--flag=value` does not.
    if (VALUE_FLAGS.has(arg) && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (known.has(value)) consumedAsValue.push({ flag: arg, value });
      rest.push(value);
      i += 1;
    }
  }
  return {
    subcommand: subcommand ?? DEFAULT_SUBCOMMAND,
    explicit: subcommand !== null,
    consumedAsValue,
    rest,
  };
}

export function migrateUsage() {
  return [
    `Usage: migrate.mjs [${MIGRATE_SUBCOMMANDS.join('|')}] [options]`,
    '',
    'workflow-storage (the default)',
    '  [--repo-root <path>] [--format text|json]',
    '  [--plugin all|engineer|orchestrator] [--apply]',
    '  Dry-run by default. --apply moves legacy .claude/agentic-* workflow state.',
    '',
    'legacy-egress-intents was removed with the egress subsystem (ADR-0064).',
  ].join('\n');
}

// --- dispatch ---------------------------------------------------------------

export async function runMigrateCli(argv) {
  const { subcommand, explicit, consumedAsValue, rest } = splitSubcommand(argv);
  // `--help` with no subcommand belongs to the DISPATCHER, not to the default
  // subcommand — it is the surface that says what this command can do, and
  // what it no longer does (cross-host review).
  if (!explicit && (argv.includes('--help') || argv.includes('-h'))) {
    return { ok: true, output: migrateUsage(), exitCode: 0 };
  }
  // Refuse the ambiguous shape rather than guessing. Guessing costs a
  // workflow-storage `--apply` against the wrong root; refusing costs one
  // retype, and the inline form disambiguates it without ceremony.
  if (!explicit && consumedAsValue.length > 0) {
    const { flag, value } = consumedAsValue[0];
    return {
      ok: false,
      // `value` is argv the operator controls, and this string reaches stderr
      // outside the report's defuser — a newline plus an escape forges an
      // operator line there just as it would inside the report (cross-host
      // review). `flag` and `value` are both defused.
      reason: `ambiguous: '${safeOperatorText(value)}' is a subcommand name but was read as the value of ${safeOperatorText(flag)}, so no subcommand was given and '${DEFAULT_SUBCOMMAND}' would run instead. If it is really the ${safeOperatorText(flag)} value, write ${safeOperatorText(flag)}=${safeOperatorText(value)}; if you meant the subcommand, give ${safeOperatorText(flag)} its own value first.`,
      usage: migrateUsage(),
    };
  }
  if (Object.hasOwn(RETIRED_MIGRATE_SUBCOMMANDS, subcommand)) {
    return {
      ok: false,
      reason: `${subcommand} was removed by ${RETIRED_MIGRATE_SUBCOMMANDS[subcommand]} with the egress subsystem it served: no runtime reads or writes an egress intent WAL any more. Nothing ran.`,
      usage: migrateUsage(),
    };
  }
  const { runWorkflowStorageCli, workflowStorageUsage } = await import('./migrate-workflow-storage.mjs');
  const res = await runWorkflowStorageCli(rest);
  // The workflow-storage runner owns its own usage text; surface that one rather
  // than the dispatcher's, so a mistyped flag is answered by the surface that
  // rejected it.
  if (!res.ok && !res.usage) return { ...res, usage: workflowStorageUsage() };
  return res;
}

async function main() {
  let argv;
  try {
    argv = expandArgsFile(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof ArgsFileError)) throw error;
    process.stderr.write(`runtime:migrate: ${error.message}\n${migrateUsage()}\n`);
    process.exitCode = 1;
    return;
  }
  const res = await runMigrateCli(argv);
  if (!res.ok) {
    process.stderr.write(`runtime:migrate: ${res.reason}\n`);
    process.stderr.write(`${res.usage ?? migrateUsage()}\n`);
    process.exitCode = 1;
    return;
  }
  if (res.output) process.stdout.write(`${res.output}\n`);
  if (res.exitCode) process.exitCode = res.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`runtime:migrate failed: ${err.stack ?? err.message}\n`);
    process.exitCode = 1;
  });
}
