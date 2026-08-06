#!/usr/bin/env node
// plugins/runtime/scripts/migrate.mjs
//
// The `runtime:migrate` dispatcher. Two subcommands:
//
//   workflow-storage        ADR-0025 legacy .claude/agentic-* → .agentic-plugins/state.
//                           Dry-run by default; mutates only with --apply.
//   legacy-egress-intents   ADR-0048 residual (d) cross-checkout discovery of
//                           pre-upgrade, repo-scoped egress intent WALs.
//                           READ-ONLY, always. There is no --apply.
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

import { runWorkflowStorageCli, workflowStorageUsage } from './migrate-workflow-storage.mjs';
import {
  DISCOVERY_EXIT_CODES,
  DEFAULT_DISCOVERY_CAPS,
  discoverLegacyEgressIntents,
  renderDiscoveryJson,
  renderDiscoveryText,
} from './lib/legacy-egress-discovery.mjs';

export const MIGRATE_SUBCOMMANDS = Object.freeze(['workflow-storage', 'legacy-egress-intents']);
const DEFAULT_SUBCOMMAND = 'workflow-storage';

// Every flag that consumes the NEXT argv element as its value, across all
// subcommands. The union is deliberate: the dispatcher must know it before it
// knows which subcommand it is routing to.
const VALUE_FLAGS = new Set([
  '--repo-root', '--format', '--plugin', '--root', '--skip', '--max-depth', '--time-budget-ms',
]);

// Split argv into { subcommand, rest }. The subcommand is removed; everything
// else is forwarded untouched, in order.
export function splitSubcommand(argv) {
  const known = new Set(MIGRATE_SUBCOMMANDS);
  const rest = [];
  let subcommand = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (subcommand === null && known.has(arg)) {
      subcommand = arg;
      continue;
    }
    rest.push(arg);
    // `--flag value` consumes the next element; `--flag=value` does not.
    if (VALUE_FLAGS.has(arg) && i + 1 < argv.length) {
      rest.push(argv[i + 1]);
      i += 1;
    }
  }
  return { subcommand: subcommand ?? DEFAULT_SUBCOMMAND, explicit: subcommand !== null, rest };
}

export function migrateUsage() {
  return [
    `Usage: migrate.mjs <${MIGRATE_SUBCOMMANDS.join('|')}> [options]`,
    '',
    'workflow-storage (default when no subcommand is given)',
    '  [--repo-root <path>] [--format text|json]',
    '  [--plugin all|engineer|orchestrator] [--apply]',
    '  Dry-run by default. --apply moves legacy .claude/agentic-* workflow state.',
    '',
    'legacy-egress-intents',
    '  [--repo-root <path>] [--format text|json] [--root <path>]... [--skip <path>]...',
    `  [--max-depth <n>] [--time-budget-ms <n>]`,
    '  READ-ONLY machine-scoped discovery of pre-upgrade egress intent WALs.',
    '  Writes nothing, spawns nothing, and never generates a shell command.',
    '  --root REPLACES the default $HOME root; --skip excludes a subtree by identity.',
    `  Defaults: max-depth=${DEFAULT_DISCOVERY_CAPS.maxDepth}, time-budget-ms=${DEFAULT_DISCOVERY_CAPS.timeBudgetMs}.`,
    '  Exit: 0 = nothing found in scope, 2 = locations found, 1 = scan incomplete.',
  ].join('\n');
}

// --- legacy-egress-intents -------------------------------------------------

// Flags this READ-ONLY subcommand refuses by NAME rather than by "unknown
// argument". An operator who types `--apply` has a mutating intent, and telling
// them "unknown argument: --apply" invites them to look for the right spelling
// of a thing that does not exist. The refusal happens during parsing, so no scan
// and no migration code runs.
const REFUSED_DISCOVERY_FLAGS = new Map([
  ['--apply', 'this subcommand is read-only by contract (ADR-0035 R0): it reports locations and never moves or removes anything'],
  ['--plugin', '--plugin selects a workflow-storage namespace; it means nothing to an egress-intent scan'],
]);

export function parseDiscoveryArgs(argv) {
  const opts = {
    repoRoot: null,
    format: 'text',
    roots: [],
    skips: [],
    maxDepth: DEFAULT_DISCOVERY_CAPS.maxDepth,
    timeBudgetMs: DEFAULT_DISCOVERY_CAPS.timeBudgetMs,
    help: false,
  };
  const take = (i, flag) => {
    const value = argv[i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  const readInt = (raw, flag, min) => {
    if (!/^\d+$/.test(raw)) throw new Error(`${flag} must be a non-negative integer (got ${raw})`);
    const n = Number(raw);
    if (n < min) throw new Error(`${flag} must be at least ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : null;
    const value = () => (inlineValue !== null ? inlineValue : take(++i, name));

    if (REFUSED_DISCOVERY_FLAGS.has(name)) {
      throw new Error(`${name} is not accepted by legacy-egress-intents — ${REFUSED_DISCOVERY_FLAGS.get(name)}`);
    }
    switch (name) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--repo-root':
        opts.repoRoot = value();
        break;
      case '--format':
        opts.format = value();
        break;
      case '--root':
        opts.roots.push(value());
        break;
      case '--skip':
        opts.skips.push(value());
        break;
      case '--max-depth':
        opts.maxDepth = readInt(value(), '--max-depth', 0);
        break;
      case '--time-budget-ms':
        opts.timeBudgetMs = readInt(value(), '--time-budget-ms', 1);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!['text', 'json'].includes(opts.format)) throw new Error('--format must be text or json');
  // `/` is refused rather than accepted-and-capped. A whole-filesystem walk is
  // an explicit non-goal, and the caps would turn it into a scan that reports
  // `incomplete` forever while costing minutes — the worst of both.
  for (const root of opts.roots) {
    if (resolve(root) === '/') {
      throw new Error('--root / is refused — a whole-filesystem scan is a non-goal; name the directories that hold your checkouts');
    }
  }
  return opts;
}

async function runDiscoveryCli(argv) {
  let opts;
  try {
    opts = parseDiscoveryArgs(argv);
  } catch (err) {
    return { ok: false, reason: err.message, usage: migrateUsage() };
  }
  if (opts.help) return { ok: true, output: migrateUsage(), exitCode: 0 };

  const report = await discoverLegacyEgressIntents({
    requestedRoots: opts.roots,
    skipPaths: opts.skips,
    repoRoot: opts.repoRoot,
    caps: { maxDepth: opts.maxDepth, timeBudgetMs: opts.timeBudgetMs },
  });
  const output = opts.format === 'json' ? renderDiscoveryJson(report) : renderDiscoveryText(report).replace(/\n$/, '');
  return { ok: true, output, report, exitCode: DISCOVERY_EXIT_CODES[report.overall.status] ?? 1 };
}

// --- dispatch ---------------------------------------------------------------

export async function runMigrateCli(argv) {
  const { subcommand, rest } = splitSubcommand(argv);
  if (subcommand === 'legacy-egress-intents') return runDiscoveryCli(rest);
  const res = await runWorkflowStorageCli(rest);
  // The workflow-storage runner owns its own usage text; surface that one rather
  // than the dispatcher's, so a mistyped flag is answered by the surface that
  // rejected it.
  if (!res.ok && !res.usage) return { ...res, usage: workflowStorageUsage() };
  return res;
}

async function main() {
  const res = await runMigrateCli(process.argv.slice(2));
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
