#!/usr/bin/env node
// plugins/runtime/scripts/lib/plugin-management-plan.mjs
//
// PURE plugin-management + plugin-cleanup PLAN HALF (machine-bootstrap-contract.md
// §1.3 extraction 5). Extracted verbatim from settings.mjs so bootstrap can compose
// the same candidate plans and — critically — recompute the SAME §1.6 plan hash from
// the same probe facts WITHOUT a source checkout (bootstrap dry-plan hash == settings
// executor hash). Every function here is pure: no fs, no subprocess, no host-CLI
// probe, no artifact write. The EXECUTE halves (executePluginManagementPlans,
// executePluginCleanupPlans, the codexInstall pre/post-flight probes, the write-ahead
// journal machinery) stay in settings.mjs, which re-imports the names it still needs.
//
// HASH INVARIANTS (do not reorder — the §1.6 drift guard depends on byte-exact repro):
//   * collectMutationActions emits action objects with the FIXED key order
//     {area, host, plugin, action, command, args};
//   * it sorts by JSON.stringify([area, command, args, host, plugin ?? '']);
//   * computeMutationPlanHash = sha256(JSON.stringify(sorted actions)).
//   * CLI availability is a hash input: buildPluginManagementCandidates dedups only
//     status==='planned' (CLI available) plans, so duplicate marketplace argvs collapse
//     to one survivor when the CLI is available but all survive as distinct 'blocked'
//     actions when it is not.

import { createHash } from 'node:crypto';

import { PLUGIN_NAMES } from './machine-probe.mjs';
import { semverCompare } from './semver.mjs';
import { pickCodexInstalledVersion } from './codex-attestation-versions.mjs';

const EXECUTABLE_PLUGIN_ACTIONS = new Set(['install-plugin', 'update-plugin', 'add-marketplace', 'upgrade-marketplace']);

const EXECUTABLE_PLUGIN_CLEANUP_ACTIONS = new Set(['uninstall-retired-plugin']);

// PURE plan half — identical durability rationale as buildPluginManagementPlan.
// The retired-plugin cleanup executor had the identical ordering defect
// (machine-bootstrap-contract.md §1.5 part 4), so it is split the same way.
function buildPluginCleanupPlans({ hostParityIssues, clis, execute, timeoutMs }) {
  const plans = [];
  for (const issue of hostParityIssues) {
    if (issue.id !== 'claude_retired_or_unknown_plugin') continue;
    const host = issue.host ?? 'claude';
    const plugin = issue.plugin;
    const command = buildPluginCleanupCommand({ host, plugin });
    const planStatus = classifyPluginCleanupPlan({
      host,
      action: 'uninstall-retired-plugin',
      argv: command?.argv ?? null,
      clis,
      execute,
    });
    plans.push({
      host,
      plugin,
      action: 'uninstall-retired-plugin',
      status: planStatus.status,
      severity: issue.severity ?? 'warning',
      executable: planStatus.executable,
      executed: false,
      command: command?.display ?? null,
      argv: command?.argv ?? null,
      detail: issue.summary,
      evidence: issue.evidence,
      next_step: execute
        ? planStatus.next_step ?? issue.next_step
        : 'Add --execute-plugin-cleanup to run this narrow cleanup executor, or run the host-native command manually.',
      reason: planStatus.reason,
      result: null,
      limits: [
        execute
          ? 'runtime:settings executes only doctor-detected retired/unknown agentic-plugins cleanup commands.'
          : 'runtime:settings does not execute plugin cleanup unless --execute-plugin-cleanup is supplied.',
        'Uninstall retired or unknown plugins only after confirming they are no longer expected in the marketplace.',
      ],
    });
  }
  const summary = summarizePluginCleanupPlans(plans);
  return {
    requested: execute,
    executed: execute,
    mode: execute ? 'explicit-plugin-cleanup-executor' : 'dry-run-plan',
    timeout_ms: timeoutMs,
    allowlist: Array.from(EXECUTABLE_PLUGIN_CLEANUP_ACTIONS).sort(),
    status: summarizePluginCleanupStatus(plans, summary),
    summary,
    plans,
    limits: [
      'No shell interpolation is used; cleanup commands are invoked as argv arrays.',
      'Only retired/unknown agentic-plugins Claude plugin uninstall commands surfaced by runtime:doctor are executable.',
      'Raw stdout and stderr are omitted from settings output.',
    ],
  };
}

function buildPluginCleanupCommand({ host, plugin }) {
  if (host !== 'claude' || typeof plugin !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(plugin)) return null;
  return commandSpec('claude', ['plugin', 'uninstall', `${plugin}@agentic-plugins`]);
}

function classifyPluginCleanupPlan({ host, action, argv, clis, execute }) {
  if (!execute) {
    return {
      status: 'manual_required',
      executable: false,
      reason: 'dry-run; cleanup executor requires --execute-plugin-cleanup',
    };
  }
  if (!EXECUTABLE_PLUGIN_CLEANUP_ACTIONS.has(action)) {
    return {
      status: 'blocked',
      executable: false,
      reason: 'action is not in the plugin-cleanup executor allowlist',
      next_step: 'Run the host-native cleanup command manually only after confirming it is expected.',
    };
  }
  if (!argv?.command || !Array.isArray(argv?.args)) {
    return {
      status: 'blocked',
      executable: false,
      reason: 'cleanup recommendation has no argv command spec',
      next_step: 'Run the host-native cleanup command manually only after confirming it is expected.',
    };
  }
  if (host !== 'claude') {
    return {
      status: 'blocked',
      executable: false,
      reason: 'only Claude retired plugin cleanup is supported',
      next_step: 'Use that host-native plugin manager manually.',
    };
  }
  const cli = clis[host];
  if (cli?.status !== 'available') {
    return {
      status: 'blocked',
      executable: false,
      reason: `${host} CLI is not available`,
      next_step: 'Install or open the host CLI before retrying cleanup.',
    };
  }
  if (['unavailable', 'blocked'].includes(cli.plugin?.status)) {
    return {
      status: 'blocked',
      executable: false,
      reason: `claude plugin CLI is ${cli.plugin.status}`,
      next_step: 'Retry cleanup from a Claude Code environment that supports claude plugin commands.',
    };
  }
  if (!cli.feature_surface?.plugin_uninstall_command) {
    return {
      status: 'blocked',
      executable: false,
      reason: 'claude plugin CLI uninstall surface is not available',
      next_step: 'Run cleanup manually in a Claude Code environment that supports claude plugin uninstall.',
    };
  }
  return {
    status: 'planned',
    executable: true,
    reason: 'allowlisted retired/unknown agentic-plugins cleanup command',
  };
}

function summarizePluginCleanupPlans(plans) {
  return {
    planned: plans.length,
    executable: plans.filter((plan) => plan.executable).length,
    executed: plans.filter((plan) => plan.status === 'executed').length,
    failed: plans.filter((plan) => plan.status === 'failed').length,
    blocked: plans.filter((plan) => plan.status === 'blocked').length,
    manual_required: plans.filter((plan) => plan.status === 'manual_required').length,
    failed_retryable: plans.filter((plan) => plan.status === 'failed' && plan.result?.retryable === true).length,
    failed_non_retryable: plans.filter((plan) => plan.status === 'failed' && plan.result?.retryable !== true).length,
  };
}

function summarizePluginCleanupStatus(plans, summary) {
  if (plans.length === 0) return 'not_needed';
  if (summary.failed > 0) return 'failed';
  if (summary.blocked > 0) return 'blocked';
  if (summary.manual_required > 0) return 'manual_required';
  if (summary.executed > 0) return 'executed';
  return 'planned';
}

function buildPluginPlans(plugins, { codexPerPluginVerbList = [], marketplaceRegistration = null } = {}) {
  const result = {};
  for (const name of PLUGIN_NAMES) {
    const plugin = plugins[name];
    const sourceVersion = plugin.source?.claude_manifest?.version ?? plugin.source?.codex_manifest?.version ?? null;
    // `./plugins/<name>` source actually exists ⟺ a source manifest was read. A consumer
    // machine has none — so a repo-catalog register-marketplace-entry is meaningless there
    // (machine-bootstrap-contract.md §1.1).
    const sourceExists = plugin.source?.present === true;
    const claudeInstalled = plugin.installed?.claude_plugin_list ?? null;
    const claudeCacheLatest = plugin.cache?.claude?.latest ?? null;
    const codexCacheLatest = plugin.cache?.codex?.latest ?? null;
    const codexTmpMarketplace = plugin.cache?.codex_tmp_marketplace ?? null;
    const codexResolved = plugin.installed?.codex_resolved ?? null;
    // §1.4.1 currentness authority: the registered marketplace catalog at installLocation
    // (from C2's probe), NOT repoRoot/plugins/<name>. Claude catalogs carry versions; Codex
    // catalogs are versionless, so codex currentness stays `unknown` and keeps the source
    // fallback below. This is the fix for the silent no-update path — a consumer has no
    // source manifest, but it does have a registered catalog.
    const catalogClaudeVersion = marketplaceRegistration?.claude?.catalog?.versions?.[name] ?? null;
    // Codex catalogs are deliberately versionless (§1.4.1), so this is null today and the
    // codex currentness target below falls back to the source manifest — but routing codex
    // through the SAME catalog-preferred target keeps the two hosts symmetric (no claude/codex
    // mirror) and picks up a per-entry version automatically if a Codex catalog ever gains one.
    const catalogCodexVersion = marketplaceRegistration?.codex?.catalog?.versions?.[name] ?? null;
    // Actual per-host INSTALLED version (peer #8 (b)/(c)) — mirrors doctor's list-authoritative
    // resolution. Bound to attestation/review-targets so they NEVER attest a catalog-latest
    // version that may not be installed; falls back to the source version so a source-tree run
    // (where nothing is "installed" via the host list) keeps reporting the built version.
    // The fallback rule lives in codex-attestation-versions.mjs so doctor's currency
    // mirror resolves an attestation's plugin versions through the identical authority.
    const codexInstalledVersion = pickCodexInstalledVersion(codexResolved, codexCacheLatest);
    result[name] = {
      status: plugin.status,
      source_version: sourceVersion,
      installed_version: codexInstalledVersion ?? claudeInstalled?.version ?? claudeCacheLatest?.manifest_version ?? null,
      // Codex list-authoritative installed evidence, kept SEPARATE from the generic
      // installed_version above (which falls through Codex → Claude → source). A /hooks
      // attestation must bind the version Codex actually loaded, so it reads this
      // decision + version via resolveCodexInstalledPluginVersion rather than the
      // fall-through field (machine-bootstrap-contract.md §8.2, S8a4).
      codex_installed: {
        version: codexInstalledVersion,
        decision: codexResolved?.decision ?? null,
        enabled: codexResolved?.enabled ?? null,
      },
      marketplace: plugin.marketplace,
      installed: {
        claude_plugin_list: claudeInstalled,
        claude_cache: summarizeCacheInstall(claudeCacheLatest),
        codex_cache: summarizeCacheInstall(codexCacheLatest),
      },
      marketplace_cache: {
        codex_tmp_marketplace: summarizeSingleManifest(codexTmpMarketplace),
      },
      recommendations: pluginRecommendations({
        name,
        sourceVersion,
        catalogClaudeVersion,
        catalogCodexVersion,
        sourceExists,
        marketplace: plugin.marketplace,
        claudeInstalled,
        claudeCacheLatest,
        codexCacheLatest,
        codexTmpMarketplace,
        codexResolved,
        codexPerPluginVerbList,
      }),
    };
  }
  return result;
}

function summarizeCacheInstall(latest) {
  if (!latest) return null;
  return {
    version: latest.manifest_version ?? null,
    path: latest.path ?? null,
  };
}

function summarizeSingleManifest(manifest) {
  if (manifest?.status !== 'available') return null;
  return {
    version: manifest.manifest_version ?? null,
    path: manifest.path ?? null,
    manifest_path: manifest.manifest_path ?? null,
  };
}

function pluginRecommendations({ name, sourceVersion, catalogClaudeVersion = null, catalogCodexVersion = null, sourceExists = false, marketplace, claudeInstalled, claudeCacheLatest, codexCacheLatest, codexTmpMarketplace, codexResolved = null, codexPerPluginVerbList = [] }) {
  const recommendations = [];
  // `add` is the per-plugin install verb and the threshold for recognizing the
  // surface; enumerate only the observed verbs so strings never overclaim.
  const codexPerPluginSurface = codexPerPluginVerbList.includes('add');
  const codexPerPluginVerbText = codexPerPluginVerbList.join('/') || 'add';
  // register-marketplace-entry is a REPO-CATALOG edit — it only makes sense where the
  // `./plugins/<name>` source exists (a checkout). On a consumer machine the source is
  // absent, so doctor honestly reports `marketplace: null`, and emitting "add <name> to
  // .claude-plugin/marketplace.json with source ./plugins/<name>" is meaningless advice
  // (machine-bootstrap-contract.md §1.1 — the sixteen false remediations). Gate it behind
  // source existence. The consumer remedy is Stage-0 host-native `marketplace add`, which
  // bootstrap detects and prints (§2 Stage 0) from C2's registration probe — not a per-plugin
  // repo-catalog edit here.
  if (sourceExists && !marketplace?.claude) {
    recommendations.push({
      host: 'claude',
      action: 'register-marketplace-entry',
      executed: false,
      command: null,
      detail: `Add ${name} to .claude-plugin/marketplace.json with source ./plugins/${name}.`,
    });
  }
  if (sourceExists && !marketplace?.codex) {
    recommendations.push({
      host: 'codex',
      action: 'register-marketplace-entry',
      executed: false,
      command: null,
      detail: `Add ${name} to .agents/plugins/marketplace.json with source ./plugins/${name}.`,
    });
  }

  // §1.4.1 currentness target: the registered marketplace catalog version (from C2), falling
  // back to the source manifest ONLY when no registered catalog answered (a source-tree run,
  // or an unregistered marketplace). This is what moves the claude currentness check off the
  // repo checkout so a consumer's stale install is actually detected.
  const claudeCurrentnessTarget = catalogClaudeVersion ?? sourceVersion;
  // Same catalog-preferred, source-fallback target for Codex (symmetric with claude). Codex
  // catalogs are versionless so this is `sourceVersion` today; both hosts route through one
  // discipline so the currentness path never conflates with the installed-version attestation.
  const codexCurrentnessTarget = catalogCodexVersion ?? sourceVersion;
  const claudeVersion = claudeInstalled?.version ?? claudeCacheLatest?.manifest_version ?? null;
  if (!claudeInstalled && !claudeCacheLatest) {
    const command = buildPluginCommand({ host: 'claude', action: 'install-plugin', name });
    recommendations.push({
      id: `${name}:claude:install-plugin`,
      host: 'claude',
      action: 'install-plugin',
      executed: false,
      command: command.display,
      argv: command.argv,
      executable: true,
      detail: 'Dry-run by default; add --execute-plugin-management to run this allowlisted host-native plugin command.',
    });
  } else if (claudeCurrentnessTarget && claudeVersion && semverCompare(String(claudeVersion), String(claudeCurrentnessTarget)) < 0) {
    const command = buildPluginCommand({ host: 'claude', action: 'update-plugin', name });
    recommendations.push({
      id: `${name}:claude:update-plugin`,
      host: 'claude',
      action: 'update-plugin',
      executed: false,
      command: command.display,
      argv: command.argv,
      executable: true,
      detail: `Installed ${claudeVersion}; ${catalogClaudeVersion ? 'registered catalog' : 'source'} ${claudeCurrentnessTarget}.`,
    });
  }

  const codexVersion = codexCacheLatest?.manifest_version ?? null;
  const codexTmpVersion = codexTmpMarketplace?.status === 'available' ? codexTmpMarketplace.manifest_version ?? null : null;
  // ADR-0034 cross-script consumer: when `codex plugin list` was authoritative,
  // it — not the filesystem cache — decides the install state, so the cache-driven
  // recommendations in the trailing `else if` chain must not contradict it. Only
  // fall through to that legacy logic when the list was unavailable (decision
  // 'fallback') or the doctor report predates codex_resolved.
  const codexDecision = codexResolved?.decision ?? null;
  const codexListVersion = codexResolved?.version ?? null;
  const codexInstallCacheStatus = codexCacheLatest ? 'present' : 'missing';
  const codexListAuthoritative = Boolean(codexResolved) && codexDecision !== 'fallback';
  if (codexListAuthoritative && codexDecision === 'installed') {
    if (codexCurrentnessTarget && codexListVersion && semverCompare(String(codexListVersion), String(codexCurrentnessTarget)) < 0) {
      const command = buildPluginCommand({ host: 'codex', action: 'upgrade-marketplace', name });
      recommendations.push({
        id: `${name}:codex:upgrade-marketplace`,
        host: 'codex',
        action: 'upgrade-marketplace',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: `Codex \`plugin list\` reports ${name} ${codexListVersion} installed; source/catalog ${codexCurrentnessTarget}. Codex upgrades via the marketplace, not a per-plugin update command.`,
        evidence: { list_decision: codexDecision, list_version: codexListVersion, install_cache_status: codexInstallCacheStatus },
      });
    } else if (!codexCacheLatest) {
      recommendations.push({
        id: `${name}:codex:materialize-plugin-cache`,
        host: 'codex',
        action: 'materialize-plugin-cache',
        executed: false,
        command: null,
        argv: null,
        executable: false,
        detail: codexPerPluginSurface
          ? `Codex \`plugin list\` reports ${name}${codexListVersion ? ` ${codexListVersion}` : ''} installed, but runtime did not find a materialized per-plugin install cache. Codex exposes per-plugin ${codexPerPluginVerbText}; runtime recognizes this surface but does not auto-execute codex plugin add (execution wiring is a deferred follow-up), so cache materialization stays manual.`
          : `Codex \`plugin list\` reports ${name}${codexListVersion ? ` ${codexListVersion}` : ''} installed, but runtime did not find a materialized per-plugin install cache; the current Codex CLI exposes marketplace add/upgrade/remove rather than per-plugin install/list, so runtime cannot execute cache materialization directly.`,
        next_step: codexPerPluginSurface
          ? `Start a fresh Codex session (or re-run \`codex plugin add ${name}@agentic-plugins\`) so the host materializes the install cache, then verify with runtime:doctor.`
          : 'Start a fresh Codex session after a marketplace refresh so the host materializes the install cache, then verify with runtime:doctor.',
        evidence: {
          command_surface: codexPerPluginSurface ? 'per-plugin-and-marketplace' : 'marketplace-only',
          list_decision: codexDecision,
          list_version: codexListVersion,
          install_cache_status: codexInstallCacheStatus,
        },
      });
    }
    // installed per list, current version, cache materialized → no recommendation.
  } else if (codexListAuthoritative && codexDecision === 'disabled') {
    recommendations.push({
      id: `${name}:codex:enable-plugin`,
      host: 'codex',
      action: 'enable-plugin',
      executed: false,
      command: null,
      argv: null,
      executable: false,
      detail: `Codex \`plugin list\` reports ${name}${codexListVersion ? ` ${codexListVersion}` : ''} installed but disabled. Cache materialization is not the issue — enable it in the host before relying on Codex-side parity.`,
      next_step: `Enable ${name} in Codex (host plugin settings), then verify with runtime:doctor.`,
      evidence: { list_decision: codexDecision, list_version: codexListVersion, install_cache_status: codexInstallCacheStatus },
    });
  } else if (codexListAuthoritative && codexDecision === 'not_installed') {
    // The list authoritatively reports not installed: recommend making it
    // available based on the marketplace cache state, ignoring any stale install
    // cache (which the list overrides).
    if (codexCurrentnessTarget && codexTmpVersion && semverCompare(String(codexTmpVersion), String(codexCurrentnessTarget)) < 0) {
      const command = buildPluginCommand({ host: 'codex', action: 'upgrade-marketplace', name });
      recommendations.push({
        id: `${name}:codex:upgrade-marketplace`,
        host: 'codex',
        action: 'upgrade-marketplace',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: `Codex \`plugin list\` does not report ${name} installed; marketplace cache has ${codexTmpVersion}, source/catalog ${codexCurrentnessTarget}. Refresh the marketplace before installing.`,
        evidence: { list_decision: codexDecision, list_version: null, install_cache_status: codexInstallCacheStatus },
      });
    } else if (codexTmpVersion && codexPerPluginSurface) {
      // The list says not installed; the marketplace cache has it; Codex exposes
      // the per-plugin `add` verb. This is an EXECUTABLE `codex plugin add`
      // (ADR-0035 §5/§6, C) — an H2 install behind --execute-plugin-management.
      // The actual installPolicy/authPolicy gate happens at execute time via a
      // `codex plugin list --available --json` pre-flight (the plain list does not
      // report not-installed plugins' policy), then a `codex plugin list --json`
      // post-verify. It never mutates Codex trust state (enabled ≠ trusted).
      const command = buildPluginCommand({ host: 'codex', action: 'install-plugin', name });
      recommendations.push({
        id: `${name}:codex:install-plugin`,
        host: 'codex',
        action: 'install-plugin',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: `Codex \`plugin list\` does not report ${name} installed; the marketplace cache has ${codexTmpVersion}. Codex exposes per-plugin ${codexPerPluginVerbText}; runtime can install it with \`codex plugin add ${name}@agentic-plugins\` (ADR-0035 §5/§6 H2 executor). Execution is policy-gated (pre-flight installPolicy=AVAILABLE + non-ON_INSTALL authPolicy via \`codex plugin list --available --json\`), runs only under --execute-plugin-management, and post-verifies installation. It never trusts hooks (enabled ≠ trusted; /hooks review is separate).`,
        next_step: `Run \`runtime:settings --execute-plugin-management\` to install ${name} from the marketplace cache (or \`codex plugin add ${name}@agentic-plugins\` manually), then verify with runtime:doctor.`,
        evidence: {
          command_surface: 'per-plugin-and-marketplace',
          list_decision: codexDecision,
          list_version: null,
          install_cache_status: codexInstallCacheStatus,
        },
      });
    } else if (codexTmpVersion) {
      // Not installed, marketplace cache present, but the current Codex CLI exposes
      // only marketplace add/upgrade/remove (no per-plugin install) — stays manual.
      recommendations.push({
        id: `${name}:codex:install-plugin-manual`,
        host: 'codex',
        action: 'install-plugin-manual',
        executed: false,
        command: null,
        argv: null,
        executable: false,
        detail: `Codex \`plugin list\` does not report ${name} installed; the marketplace cache has ${codexTmpVersion}, but the current Codex CLI exposes marketplace add/upgrade/remove rather than per-plugin install/list, so runtime cannot install it directly.`,
        next_step: `Install ${name} through the Codex host plugin surface (the current CLI exposes no per-plugin install verb), then verify with runtime:doctor. A fresh session alone does not install it.`,
        evidence: {
          command_surface: 'marketplace-only',
          list_decision: codexDecision,
          list_version: null,
          install_cache_status: codexInstallCacheStatus,
        },
      });
    } else {
      const command = buildPluginCommand({ host: 'codex', action: 'add-marketplace', name });
      recommendations.push({
        id: `${name}:codex:add-marketplace`,
        host: 'codex',
        action: 'add-marketplace',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: codexPerPluginSurface
          ? `Codex \`plugin list\` does not report ${name} installed and no marketplace catalog is configured. Codex exposes per-plugin ${codexPerPluginVerbText} plus marketplace add/list/upgrade/remove; add the marketplace catalog first.`
          : `Codex \`plugin list\` does not report ${name} installed and no marketplace catalog is configured. Add the marketplace catalog to make ${name} available.`,
        evidence: { list_decision: codexDecision, list_version: null, install_cache_status: codexInstallCacheStatus },
      });
    }
  } else if (!codexCacheLatest) {
    if (codexCurrentnessTarget && codexTmpVersion && semverCompare(String(codexTmpVersion), String(codexCurrentnessTarget)) < 0) {
      const command = buildPluginCommand({ host: 'codex', action: 'upgrade-marketplace', name });
      recommendations.push({
        id: `${name}:codex:upgrade-marketplace`,
        host: 'codex',
        action: 'upgrade-marketplace',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: `Codex marketplace cache has ${codexTmpVersion}; source/catalog ${codexCurrentnessTarget}. Codex upgrades via the marketplace, not a per-plugin update command.`,
      });
    } else if (codexTmpVersion) {
      recommendations.push({
        id: `${name}:codex:materialize-plugin-cache`,
        host: 'codex',
        action: 'materialize-plugin-cache',
        executed: false,
        command: null,
        argv: null,
        executable: false,
        detail: codexPerPluginSurface
          ? `Codex marketplace cache already has ${name} ${codexTmpVersion}, but no per-plugin install cache was found. Codex exposes per-plugin ${codexPerPluginVerbText}; runtime recognizes this surface but does not auto-execute codex plugin add (execution wiring is a deferred follow-up), so cache materialization stays manual.`
          : `Codex marketplace cache already has ${name} ${codexTmpVersion}, but no per-plugin install cache was found. Current Codex CLI exposes marketplace add/upgrade/remove rather than per-plugin install/list, so runtime cannot execute cache materialization directly.`,
        next_step: codexPerPluginSurface
          ? `Run \`codex plugin add ${name}@agentic-plugins\` manually or start a fresh Codex session, then verify host cache materialization with runtime:doctor. Do not repeat marketplace add unless the marketplace cache is missing or stale.`
          : 'Start a fresh Codex session or invoke the plugin surface after marketplace refresh, then verify host cache materialization with runtime:doctor. Do not repeat marketplace add unless the marketplace cache is missing or stale.',
        evidence: {
          command_surface: codexPerPluginSurface ? 'per-plugin-and-marketplace' : 'marketplace-only',
          marketplace_cache_version: codexTmpVersion,
          install_cache_status: 'missing',
        },
      });
    } else {
      const command = buildPluginCommand({ host: 'codex', action: 'add-marketplace', name });
      recommendations.push({
        id: `${name}:codex:add-marketplace`,
        host: 'codex',
        action: 'add-marketplace',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: codexPerPluginSurface
          ? `Codex exposes per-plugin ${codexPerPluginVerbText} plus marketplace add/list/upgrade/remove; add the marketplace catalog first so ${name} can be installed.`
          : `Codex exposes marketplace add/upgrade/remove, not per-plugin install; add the marketplace catalog to make ${name} available.`,
      });
    }
  } else if (codexCurrentnessTarget && codexVersion && semverCompare(String(codexVersion), String(codexCurrentnessTarget)) < 0) {
    const command = buildPluginCommand({ host: 'codex', action: 'upgrade-marketplace', name });
    recommendations.push({
      id: `${name}:codex:upgrade-marketplace`,
      host: 'codex',
      action: 'upgrade-marketplace',
      executed: false,
      command: command.display,
      argv: command.argv,
      executable: true,
      detail: `Cached ${codexVersion}; source/catalog ${codexCurrentnessTarget}. Codex upgrades via the marketplace, not a per-plugin update command.`,
    });
  }
  return recommendations;
}

function buildPluginCommand({ host, action, name }) {
  if (host === 'claude' && action === 'install-plugin') {
    return commandSpec('claude', ['plugin', 'install', `${name}@agentic-plugins`]);
  }
  if (host === 'claude' && action === 'update-plugin') {
    return commandSpec('claude', ['plugin', 'update', `${name}@agentic-plugins`]);
  }
  if (host === 'codex' && action === 'install-plugin') {
    // ADR-0035 §5/§6 (C): H2 per-plugin install. Fixed argv — NO -c/--config,
    // --enable, or --disable (config-injection / feature-toggle escalation).
    // Execution is policy-gated at run time (pre-flight installPolicy/authPolicy).
    return commandSpec('codex', ['plugin', 'add', `${name}@agentic-plugins`]);
  }
  if (host === 'codex' && action === 'add-marketplace') {
    return commandSpec('codex', ['plugin', 'marketplace', 'add', 'each4all/agentic-plugins']);
  }
  if (host === 'codex' && action === 'upgrade-marketplace') {
    return commandSpec('codex', ['plugin', 'marketplace', 'upgrade', 'agentic-plugins']);
  }
  return null;
}

function commandSpec(command, args) {
  return {
    display: [command, ...args].join(' '),
    argv: { command, args },
  };
}

// PURE plan half (machine-bootstrap-contract.md §1.3/§1.5): builds the candidate
// plan set with NO runner, NO subprocess, NO artifact write. The execute half is
// executePluginManagementPlans() below, which the write-ahead orchestrator drives
// AFTER the `planned` record lands on disk. Splitting alone changes nothing about
// durability (§1.5) — the write-ahead sequencing in runSettings is the fix.
function buildPluginManagementPlan({ plugins, clis, execute, hostFilter, timeoutMs }) {
  const plans = buildPluginManagementCandidates({ plugins, clis, hostFilter });
  return {
    requested: execute,
    executed: execute,
    mode: execute ? 'explicit-plugin-management-executor' : 'dry-run-plan',
    host_filter: hostFilter,
    timeout_ms: timeoutMs,
    allowlist: Array.from(EXECUTABLE_PLUGIN_ACTIONS).sort(),
    plans,
    summary: summarizePluginManagementPlans(plans),
    manual_followups: buildPluginManagementManualFollowups(plans),
    limits: [
      'No shell interpolation is used; executable commands are invoked as argv arrays.',
      'Only install/update/add/upgrade plugin-management actions are executable.',
      'Marketplace catalog file registration remains manual because it is a repository edit, not a host plugin command.',
      'Raw stdout and stderr are omitted from settings output.',
    ],
  };
}

function buildPluginManagementCandidates({ plugins, clis, hostFilter }) {
  const plans = [];
  const seenExecutableCommands = new Map();
  for (const [pluginName, plugin] of Object.entries(plugins)) {
    for (const recommendation of plugin.recommendations) {
      const basePlan = {
        id: recommendation.id ?? `${pluginName}:${recommendation.host}:${recommendation.action}`,
        plugin: pluginName,
        host: recommendation.host,
        action: recommendation.action,
        command: recommendation.command,
        argv: recommendation.argv ?? null,
        executed: false,
        result: null,
        detail: recommendation.detail,
        next_step: recommendation.next_step ?? null,
        evidence: recommendation.evidence ?? null,
      };
      const status = classifyPluginManagementPlan({ recommendation, hostFilter, clis });
      plans.push({ ...basePlan, ...status });
      const plan = plans.at(-1);
      if (plan.status !== 'planned') continue;
      const commandKey = `${plan.argv.command}\0${plan.argv.args.join('\0')}`;
      const duplicateOf = seenExecutableCommands.get(commandKey);
      if (duplicateOf) {
        plan.status = 'deduplicated';
        plan.executable = false;
        plan.reason = `same host command already planned by ${duplicateOf}`;
        plan.duplicate_of = duplicateOf;
      } else {
        seenExecutableCommands.set(commandKey, plan.id);
      }
    }
  }
  return plans;
}

function buildPluginManagementManualFollowups(plans) {
  const followups = [];
  const claudeSurfaceBlocked = plans.filter((plan) => (
    plan.host === 'claude'
      && plan.status === 'blocked'
      && /claude plugin CLI (?:is unavailable|install\/update surface is not available)|plugin command surface is (?:unavailable|blocked)/i.test(plan.reason ?? '')
  ));
  if (claudeSurfaceBlocked.length > 0) {
    followups.push({
      id: 'claude-plugin-surface-unavailable',
      host: 'claude',
      status: 'manual_required',
      reason: 'Claude plugin CLI command surface is unavailable to runtime:settings in this environment.',
      environment: 'Open a Claude Code environment that supports claude plugin commands.',
      commands: uniqueStrings(claudeSurfaceBlocked
        .map((plan) => claudePluginCommand(plan.argv?.args))
        .filter(Boolean)),
      verify: 'Re-run runtime:settings or runtime:doctor after completing the commands.',
    });
  }
  // ADR-0035 §6 (C) — a codex install blocked by the installPolicy/authPolicy
  // pre-flight gets explicit manual recovery guidance (§3 invariant 8), with the
  // exact `codex plugin add` the operator can run themselves after resolving the
  // policy condition. Runtime will not run it because the host reported it unsafe
  // to install non-interactively.
  const codexInstallBlocked = plans.filter((plan) => (
    plan.host === 'codex' && plan.action === 'install-plugin' && plan.status === 'blocked'
  ));
  if (codexInstallBlocked.length > 0) {
    followups.push({
      id: 'codex-install-policy-blocked',
      host: 'codex',
      status: 'manual_required',
      reason: 'Codex reported one or more plugins as unsafe to install non-interactively (installPolicy/authPolicy pre-flight blocked them).',
      reasons: uniqueStrings(codexInstallBlocked.map((plan) => plan.block_reason).filter(Boolean)),
      commands: uniqueStrings(codexInstallBlocked.map((plan) => plan.command).filter(Boolean)),
      verify: 'Resolve the policy condition (e.g. authenticate when authPolicy is ON_INSTALL), run the command manually, then re-run runtime:doctor.',
    });
  }
  return followups;
}

function buildPluginCleanupManualFollowups(plans) {
  const cleanupPlans = plans.filter((plan) => (
    plan.host === 'claude'
      && ['manual_required', 'blocked', 'failed'].includes(plan.status)
      && plan.action === 'uninstall-retired-plugin'
  ));
  if (cleanupPlans.length === 0) return [];
  const commands = uniqueStrings(cleanupPlans
    .map((plan) => claudeCommandDisplay(plan.command))
    .filter(Boolean));
  if (commands.length === 0) return [];
  return [{
    id: 'claude-retired-plugin-cleanup',
    host: 'claude',
    status: cleanupPlans.some((plan) => plan.status === 'failed') ? 'manual_required' : cleanupPlans.some((plan) => plan.status === 'blocked') ? 'manual_check' : 'manual_required',
    reason: cleanupPlans.some((plan) => ['blocked', 'failed'].includes(plan.status))
      ? 'Claude retired or unknown agentic-plugins cleanup could not be completed by runtime:settings.'
      : 'Claude has retired or unknown agentic-plugins entries that require explicit cleanup execution or a manual host-native uninstall.',
    environment: 'Open a Claude Code environment that supports claude plugin commands.',
    commands,
    verify: 'Re-run runtime:settings or runtime:doctor after completing the commands.',
  }];
}

function claudePluginCommand(args) {
  if (!Array.isArray(args) || args[0] !== 'plugin') return null;
  return ['claude', ...args].join(' ');
}

function claudeCommandDisplay(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/^(claude\s+plugin\s+.+)$/);
  return match ? match[1] : null;
}

function uniqueStrings(values) {
  return Array.from(new Set(values));
}

function classifyPluginManagementPlan({ recommendation, hostFilter, clis }) {
  if (hostFilter !== 'all' && recommendation.host !== hostFilter) {
    return {
      status: 'skipped',
      executable: false,
      reason: `filtered by --plugin-management-host=${hostFilter}`,
    };
  }
  if (!EXECUTABLE_PLUGIN_ACTIONS.has(recommendation.action)) {
    return {
      status: 'manual',
      executable: false,
      reason: 'action is not in the plugin-management executor allowlist',
    };
  }
  if (!recommendation.argv?.command || !Array.isArray(recommendation.argv?.args)) {
    return {
      status: 'manual',
      executable: false,
      reason: 'recommendation has no argv command spec',
    };
  }
  const cli = clis[recommendation.host];
  if (cli?.status !== 'available') {
    return {
      status: 'blocked',
      executable: false,
      reason: `${recommendation.host} CLI is not available`,
    };
  }
  if (recommendation.host === 'claude' && ['unavailable', 'blocked'].includes(cli.plugin?.status)) {
    return {
      status: 'blocked',
      executable: false,
      reason: `claude plugin CLI is ${cli.plugin.status}`,
    };
  }
  if (
    recommendation.host === 'claude'
      && ['install-plugin', 'update-plugin'].includes(recommendation.action)
      && !cli.feature_surface?.plugin_install_command
  ) {
    return {
      status: 'blocked',
      executable: false,
      reason: 'claude plugin CLI install/update surface is not available',
    };
  }
  return {
    status: 'planned',
    executable: true,
    reason: 'allowlisted host-native plugin command',
  };
}

function summarizePluginManagementPlans(plans) {
  const summary = {
    planned: 0,
    executed: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    manual: 0,
    deduplicated: 0,
    failed_retryable: 0,
    failed_non_retryable: 0,
  };
  for (const plan of plans) {
    if (Object.hasOwn(summary, plan.status)) summary[plan.status] += 1;
    if (plan.status === 'failed' && plan.result?.retryable === true) summary.failed_retryable += 1;
    if (plan.status === 'failed' && plan.result?.retryable !== true) summary.failed_non_retryable += 1;
  }
  return summary;
}

// The mode-invariant executable-action set both the dry-run plan (which bootstrap
// reads) and the execute run compute identically — keyed on argv + allowlisted
// action, NEVER on execute-derived status. Plugin-management drops host-filtered
// (`skipped`) and `deduplicated` plans (they will not run under this invocation);
// CLI-availability (`blocked`) is environmental, not a plan-identity change, so it
// stays in the set. Cleanup has no host filter. This is the input to the plan hash
// (machine-bootstrap-contract.md §1.6) and the durable `planned_actions` record.
function collectMutationActions({ pluginManagement, pluginCleanup }) {
  const actions = [];
  for (const plan of pluginManagement?.plans ?? []) {
    if (!EXECUTABLE_PLUGIN_ACTIONS.has(plan.action)) continue;
    if (!plan.argv?.command || !Array.isArray(plan.argv?.args)) continue;
    if (plan.status === 'skipped' || plan.status === 'deduplicated') continue;
    actions.push({ area: 'plugin-management', host: plan.host, plugin: plan.plugin ?? null, action: plan.action, command: plan.argv.command, args: plan.argv.args });
  }
  for (const plan of pluginCleanup?.plans ?? []) {
    if (!EXECUTABLE_PLUGIN_CLEANUP_ACTIONS.has(plan.action)) continue;
    if (!plan.argv?.command || !Array.isArray(plan.argv?.args)) continue;
    actions.push({ area: 'plugin-cleanup', host: plan.host, plugin: plan.plugin ?? null, action: plan.action, command: plan.argv.command, args: plan.argv.args });
  }
  const sortKey = (a) => JSON.stringify([a.area, a.command, a.args, a.host, a.plugin ?? '']);
  actions.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return actions;
}

// §1.6 drift guard: bootstrap presents `runtime:settings --execute-plugin-management`
// carrying this hash; the executor recomputes it against a fresh plan and refuses on
// divergence rather than run a plan the operator never saw.
function computeMutationPlanHash(actions) {
  return createHash('sha256').update(JSON.stringify(actions)).digest('hex');
}

export {
  EXECUTABLE_PLUGIN_ACTIONS,
  EXECUTABLE_PLUGIN_CLEANUP_ACTIONS,
  buildPluginCleanupPlans,
  buildPluginCleanupCommand,
  classifyPluginCleanupPlan,
  summarizePluginCleanupPlans,
  summarizePluginCleanupStatus,
  buildPluginPlans,
  summarizeCacheInstall,
  summarizeSingleManifest,
  pluginRecommendations,
  buildPluginCommand,
  commandSpec,
  buildPluginManagementPlan,
  buildPluginManagementCandidates,
  buildPluginManagementManualFollowups,
  buildPluginCleanupManualFollowups,
  claudePluginCommand,
  claudeCommandDisplay,
  uniqueStrings,
  classifyPluginManagementPlan,
  summarizePluginManagementPlans,
  collectMutationActions,
  computeMutationPlanHash,
};
