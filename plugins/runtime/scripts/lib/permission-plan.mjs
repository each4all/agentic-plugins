// plugins/runtime/scripts/lib/permission-plan.mjs
//
// The ADR-0038 M1 cross-host permission planner — machine-bootstrap-contract.md §1.3
// row 3, lifted out of scripts/settings.mjs.
//
// Split the way rows 1/2 (notification-plan.mjs, egress-launcher-plan.mjs) are:
//
//   gatherPermissionPlanInputs({ repoRoot, homeDir, env, ... })  async — every read
//   buildPermissionPlanSection({ gathered, now, runId, ... })    pure  — no I/O, no repoRoot
//   writePermissionAdvisoryArtifact({ repoRoot, artifact })      async — injected persist
//   buildCrossHostPermissionPlan({ ... })                        the composed wrapper
//
// The persist half is NOT re-implemented here: permission-artifacts.mjs already ships
// the pure sanitizing constructor (makePermissionAdvisoryArtifact) beside the injected
// writer (writePermissionAdvisoryArtifact). A second artifact writer would be a place
// for the two to disagree about what "sanitized" means.
//
// Two properties this module owes its callers, both load-bearing:
//
//  1. The build half takes NO repoRoot. Not because the old repoRoot use was impure —
//     it was one string stamped into a [projects."..."] header — but because a builder
//     that ACCEPTS a repo root is a builder that can grow a repo-relative read later,
//     and §1.3's whole point is that bootstrap composes these planners without writing
//     into whichever repository invoked it. The Codex project-trust target arrives
//     inside `gathered` as an explicit { applicable, path } instead: a caller with no
//     project context says so, rather than passing a null that renders [projects."null"].
//
//  2. The failure boundary is preserved exactly. ONLY usage-record enumeration degrades
//     to a blocked plan; the learner, the host-config reads, artifact construction, and
//     persistence all propagate today and must keep propagating. A broad try/catch
//     around the gatherer would convert a real fault into a serene "blocked" report.

import { collectUsageRecordSources } from './permission-usage-sources.mjs';
import { readClaudePermissionConfig, readCodexPermissionConfig } from './permission-config.mjs';
import { learnFromSources } from './permission-usage-learner.mjs';
import { makeFragmentContract, makeModeRecommendation, worstGrade } from './permission-advisor-core.mjs';
import {
  makePermissionAdvisoryArtifact,
  makePermissionRunId,
  writePermissionAdvisoryArtifact,
} from './permission-artifacts.mjs';
import { tomlBasicString } from './toml.mjs';
import { RUNTIME_VERSION } from '../version.mjs';

// ---------------------------------------------------------------------------
// Claude item rendering + host-rule precedence
// ---------------------------------------------------------------------------

function renderClaudePermissionItem(rule) {
  switch (rule.cause) {
    case 'claude.bash-not-allowlisted':
      return `Bash(${rule.pattern})`;
    case 'claude.webfetch-domain':
      return `WebFetch(domain:${rule.pattern})`;
    case 'claude.mcp-not-allowed':
      return rule.pattern;
    default:
      return null;
  }
}

// Parse a Claude permission item into { tool, spec }; spec is null for a bare
// tool (e.g. "Bash" governs all Bash).
function parseClaudePermissionItem(item) {
  const m = String(item).match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/);
  if (!m) return null;
  return { tool: m[1], spec: m[2] === undefined ? null : m[2] };
}

// Normalize a Bash specifier to its prefix by stripping a trailing wildcard.
// Claude documents ":*" as equivalent to a trailing " *". "npm run *" /
// "npm run:*" -> "npm run"; "npm:*" -> "npm"; "*" -> "" (matches everything).
function bashSpecPrefix(spec) {
  if (spec === '*') return '';
  return spec.replace(/:\*$/, '').replace(/\s*\*$/, '').trim();
}

// Does an existing Claude rule GOVERN a recommended item (making the
// recommendation redundant)? Same tool required. A bare tool or "*"/empty
// Bash spec governs all of that tool. For Bash, an existing prefix governs a
// recommended item whose prefix starts with it on a token boundary ("npm"
// governs "npm run"; "npm test" does not). Non-Bash tools use normalized exact
// match. (Plan-verify peer MAJOR: ":*"≡" *", bare tool, and broader prefixes.)
function claudePermissionGoverns(existing, recommended) {
  const e = parseClaudePermissionItem(existing);
  const r = parseClaudePermissionItem(recommended);
  if (!e || !r || e.tool !== r.tool) return false;
  if (e.spec === null) return true;
  if (e.tool === 'Bash') {
    const ep = bashSpecPrefix(e.spec);
    if (ep === '') return true;
    const rp = bashSpecPrefix(r.spec ?? '');
    return rp === ep || rp.startsWith(`${ep} `);
  }
  const normalize = (s) => (s ?? '').replace(/:\*$/, '').replace(/\s*\*$/, '').trim();
  return normalize(e.spec) === normalize(r.spec);
}

function governedByClaudeRules(ruleSet, recommended) {
  for (const existing of ruleSet) {
    if (claudePermissionGoverns(existing, recommended)) return true;
  }
  return false;
}

// Which bucket of the operator's OWN .claude/settings already governs this
// pattern, in the host's precedence order (deny beats ask beats allow) — or null
// if none does.
function claudeGoverningBucket(hostConfig, item) {
  if (governedByClaudeRules(hostConfig.deny, item)) return 'deny';
  if (governedByClaudeRules(hostConfig.ask, item)) return 'ask';
  if (governedByClaudeRules(hostConfig.allow, item)) return 'allow';
  return null;
}

// ---------------------------------------------------------------------------
// Limits text
// ---------------------------------------------------------------------------

function permissionPlanLimits(capNote) {
  const limits = [
    'runtime:settings permission plan is a dry-run (M1): it emits the recommended .claude/settings.json fragment and writes plan+evidence to an agentic-plugins-owned artifact, but NEVER writes host config — apply it yourself by merging the fragment.',
    'Recommendations are safety-graded (allow for known-safe families; deny/ask retained for dangerous shapes) and never recommend bypassPermissions as a default.',
    'The operator\'s standing rules outrank an observation: a pattern already governed by an equal-or-STRICTER host rule (same bucket, or a standing deny/ask over a safer-looking observation) is never re-recommended — the plan never emits a rule WEAKER than one already set. Where the advisor is STRICTER than the existing rule (a dangerous pattern sitting in allow), it surfaces the conflict AND still recommends the corrective rule. The host allow/deny/ask sets are read read-only and never added to apply targets.',
    'Evidence retains only generalized patterns + counts (ADR-0038 §5); raw commands, arguments, and source paths are never surfaced.',
  ];
  if (capNote) limits.push(capNote);
  return limits;
}

function codexPermissionPlanLimits(capNote) {
  const limits = [
    'runtime:settings Codex permission plan is a dry-run (M1): it emits the recommended ~/.codex/config.toml fragment and writes plan+evidence to an agentic-plugins-owned artifact, but NEVER writes host config — apply it yourself.',
    'Recommendations are safety-graded postures (approval_policy=on-request, sandbox_mode=workspace-write) and NEVER recommend danger-full-access (or approval_policy=never) as a default; those appear only as explicitly-labeled isolated-environment notes.',
    'The host ~/.codex/config.toml is read read-only and never added to apply targets; only a posture that is currently prompting is recommended (one already at/looser than the recommendation is left unchanged).',
    'Evidence retains only generalized patterns + counts (ADR-0038 §5); raw commands, arguments, and source paths are never surfaced.',
  ];
  if (capNote) limits.push(capNote);
  return limits;
}

function capNoteFor(scan, maxFiles) {
  const capNotes = [];
  if (scan.found > scan.used) capNotes.push(`per-host file cap (${maxFiles}) reached`);
  if (scan.scan_truncated) capNotes.push('directory scan hit the safety budget');
  if (scan.skipped_too_large) capNotes.push(`skipped ${scan.skipped_too_large} oversized record(s) above the per-file byte cap`);
  return capNotes.length ? `${capNotes.join('; ')}.` : null;
}

// ---------------------------------------------------------------------------
// Codex config.toml fragment rendering
// ---------------------------------------------------------------------------

export function renderCodexConfigToml({ approvalPolicy, sandboxMode, projectTrust }) {
  const lines = [];
  if (approvalPolicy) lines.push(`approval_policy = ${tomlBasicString(approvalPolicy)}`);
  if (sandboxMode) lines.push(`sandbox_mode = ${tomlBasicString(sandboxMode)}`);
  if (projectTrust) {
    if (lines.length) lines.push('');
    lines.push(`[projects.${tomlBasicString(projectTrust.path)}]`);
    lines.push(`trust_level = ${tomlBasicString(projectTrust.trust_level)}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// ---------------------------------------------------------------------------
// GATHER (§1.3) — every read lives here
// ---------------------------------------------------------------------------

/**
 * Read everything the pure builder needs: the usage-record scan, the learned
 * evidence, and both hosts' permission configs.
 *
 * `projectTrust` is the explicit trust target for the Codex plan. A caller with a
 * repository passes `{ applicable: true, path: repoRoot }`; a caller without project
 * context passes `{ applicable: false, path: null }` and the builder recommends no
 * project trust at all. It is modelled as a pair rather than a nullable string because
 * "no project context" and "a project whose path happens to be missing" are different
 * claims, and only the pair can say the first one.
 *
 * Failure boundary (preserved from settings.mjs): ONLY the usage-record scan degrades
 * — it returns `{ scanError }` and the builder renders the dual blocked plan. Every
 * other read throws, exactly as it does today.
 */
export async function gatherPermissionPlanInputs({
  repoRoot,
  homeDir,
  env,
  maxFiles,
  maxFileBytes,
  projectTrust = { applicable: true, path: repoRoot },
}) {
  let collected;
  try {
    collected = await collectUsageRecordSources({ homeDir, env, maxFiles, maxFileBytes });
  } catch (err) {
    return { scanError: err.code ?? err.message, maxFiles, projectTrust };
  }

  const learner = learnFromSources(collected.sources);
  const claudeHostConfig = await readClaudePermissionConfig({ repoRoot, homeDir });
  const codexHostConfig = await readCodexPermissionConfig({ homeDir, env, repoRoot });

  return {
    scanError: null,
    learner,
    scanned: collected.scanned,
    claudeHostConfig,
    codexHostConfig,
    maxFiles,
    projectTrust,
  };
}

// ---------------------------------------------------------------------------
// BUILD (§1.3) — pure: no I/O, no repoRoot, no clock of its own
// ---------------------------------------------------------------------------

// Builds the Claude SECTION + its fragment contract from the shared cross-host
// learner. It does NOT collect/learn (the caller does that once) and does NOT write the
// artifact (the caller writes ONE combined cross-host artifact — Plan-verify peer
// MAJOR: per-host artifacts clobbered the shared latest.json). Status is per-host
// (claude evidence), not the combined learner.
function buildClaudeSection({ hostConfig, learner, scan, maxFiles }) {
  const claudeRules = learner.rules.filter((rule) => rule.host === 'claude');
  const claudeHasEvidence = claudeRules.length > 0 || learner.modeEvidence.some((m) => m.host === 'claude');

  const allow = [];
  const deny = [];
  const ask = [];
  const conflicts = [];
  const fragmentRules = [];
  let alreadyGoverned = 0;
  // The operator's own .claude/settings outranks an observation. That is ONE
  // strictness comparison (deny > ask > allow), not a per-grade branch — and
  // writing it as per-grade branches is exactly what left cells of the matrix
  // unhandled, twice:
  //
  //   observed | in allow[]        | in ask[]          | in deny[]
  //   ---------+-------------------+-------------------+------------------
  //   allow    | governed, skip    | operator stricter | operator stricter
  //   ask      | WE are stricter   | governed, skip    | operator stricter
  //   deny     | WE are stricter   | WE are stricter   | governed, skip
  //
  //   same bucket        -> already governed: recommend nothing, no conflict.
  //   operator stricter  -> their standing decision stands: surface the conflict
  //                         and recommend NOTHING. Never emit a rule WEAKER than
  //                         what the operator already set — that is the advisor
  //                         arguing with its own operator.
  //   we are stricter    -> safety escalation: surface the conflict AND still
  //                         recommend the corrective rule, so a dangerous pattern
  //                         sitting in allow[] is never silently suppressed.
  //
  // An earlier Plan-verify closed `deny`/`ask` observed against allow[]. The
  // commit before this one closed the `allow` row. The `ask`-observed-against-an
  // explicit-`deny` cell was still open: it recommended the pattern straight back
  // into ask[], with conflicts=[] and already_allowed_count=0 — silently relaxing
  // a standing deny into a prompt. Host deny-precedence contained the blast, but
  // the plan still contradicted the operator and the shipped limits text still
  // claimed allow/deny/ask were all excluded. Same defect, mirror cell. State the
  // invariant once so there is no third mirror to find.
  for (const rule of claudeRules) {
    const item = renderClaudePermissionItem(rule);
    if (!item) continue; // file-modification → defaultMode, handled below
    const bucket = claudeGoverningBucket(hostConfig, item);
    if (bucket === rule.grade) {
      alreadyGoverned += 1;
      continue;
    }
    if (bucket && worstGrade(bucket, rule.grade) === bucket) {
      conflicts.push({
        item,
        grade: rule.grade,
        reason: `observed as ${rule.grade} but already governed by permissions.${bucket} in .claude/settings; the operator's ${bucket} stands — not recommended for ${rule.grade}`,
      });
      alreadyGoverned += 1;
      continue;
    }
    if (bucket) {
      conflicts.push({
        item,
        grade: rule.grade,
        reason: `currently ${bucket === 'allow' ? 'allowed' : bucket} in .claude/settings but graded ${rule.grade}; move it to permissions.${rule.grade}`,
      });
    }
    if (rule.grade === 'deny') deny.push(item);
    else if (rule.grade === 'ask') ask.push(item);
    else allow.push(item);
    fragmentRules.push(rule);
  }

  let modeRecommendation = null;
  const hasFileMod = learner.modeEvidence.some((m) => m.host === 'claude' && m.cause === 'claude.file-modification');
  const modeAlreadySet = hostConfig.defaultMode === 'acceptEdits' || hostConfig.defaultMode === 'bypassPermissions';
  if (hasFileMod && !modeAlreadySet) {
    modeRecommendation = makeModeRecommendation({
      setting: 'defaultMode',
      value: 'acceptEdits',
      reason: 'clear repeated file-modification prompts (Edit/Write)',
    });
  }

  const fragment = makeFragmentContract({
    host: 'claude',
    rules: fragmentRules,
    modeRecommendation,
    notes: ['merge into .claude/settings.json permissions; runtime never writes host config'],
  });

  const fragmentJson = { permissions: {} };
  if (allow.length) fragmentJson.permissions.allow = allow;
  if (deny.length) fragmentJson.permissions.deny = deny;
  if (ask.length) fragmentJson.permissions.ask = ask;
  // Claude places the scalar at permissions.defaultMode, not top-level
  // (Plan-verify peer MAJOR, verified vs Claude docs).
  if (modeRecommendation) fragmentJson.permissions.defaultMode = modeRecommendation.value;

  // Per-host cap note reflects the CLAUDE scan only (Plan-verify peer MINOR).
  const capNote = capNoteFor(scan, maxFiles);

  return {
    section: {
      requested: true,
      executed: true,
      status: claudeHasEvidence ? 'analyzed' : 'baseline',
      host: 'claude',
      sources_scanned: {
        found: scan.found,
        used: scan.used,
        scan_truncated: scan.scan_truncated,
        skipped_too_large: scan.skipped_too_large,
      },
      host_config: { read_only: true, sources: hostConfig.sources, default_mode: hostConfig.defaultMode },
      recommended: {
        allow,
        deny,
        ask,
        default_mode: modeRecommendation ? { value: modeRecommendation.value, reason: modeRecommendation.reason } : null,
        count: allow.length + deny.length + ask.length + (modeRecommendation ? 1 : 0),
      },
      conflicts,
      already_allowed_count: alreadyGoverned,
      fragment: fragmentJson,
      fragment_text: JSON.stringify(fragmentJson, null, 2),
      evidence: {
        rule_count: claudeRules.length,
        total_seen: claudeRules.reduce((sum, rule) => sum + rule.evidence.count, 0),
        baseline_used: !claudeHasEvidence,
      },
      limits: permissionPlanLimits(capNote),
    },
    fragmentContract: fragment,
    artifactNotes: [],
  };
}

// ADR-0038 settings-codex — the M1 Codex permission plan. Codex governs by
// POSTURE (approval_policy / sandbox_mode), not a per-command allowlist, so the
// plan recommends safety-graded postures grounded in usage evidence
// (approval-requested → approval_policy; sandbox-blocked → sandbox_mode), plus a
// bounded [projects."<repo>"] trust_level entry, rendered as a config.toml
// fragment. Reads host config read-only; never writes it; never danger-full-access.
// Builds the Codex SECTION + its fragment contracts from the shared cross-host
// learner. Like the Claude builder it does NOT collect/learn or write the
// artifact — the caller writes one combined cross-host artifact. Status is
// per-host (codex evidence).
function buildCodexSection({ hostConfig, projectTrust, learner, scan, maxFiles }) {
  const codexRules = learner.rules.filter((rule) => rule.host === 'codex');
  const modeEvidence = learner.modeEvidence.filter((m) => m.host === 'codex');
  const codexHasEvidence = codexRules.length > 0 || modeEvidence.length > 0;

  const fragments = [];
  const recommended = { approval_policy: null, sandbox_mode: null, project_trust: null, count: 0 };
  const isolatedNotes = [];
  const artifactNotes = [];

  const approvalSeen = modeEvidence.find((m) => m.cause === 'codex.approval-requested');
  if (approvalSeen) {
    if (hostConfig.approvalPolicy !== 'on-request' && hostConfig.approvalPolicy !== 'never') {
      const mode = makeModeRecommendation({
        setting: 'approval_policy',
        value: 'on-request',
        reason: `approval requested ${approvalSeen.count}x; on-request prompts only on escalation/failure`,
      });
      fragments.push(makeFragmentContract({ host: 'codex', rules: [], modeRecommendation: mode, notes: [] }));
      recommended.approval_policy = { value: 'on-request', reason: mode.reason };
      recommended.count += 1;
    }
    isolatedNotes.push('approval_policy="never" removes approval prompts entirely — isolated-environment only, never a recommended default.');
  }

  const sandboxSeen = modeEvidence.find((m) => m.cause === 'codex.sandbox-blocked');
  if (sandboxSeen) {
    if (hostConfig.sandboxMode !== 'workspace-write' && hostConfig.sandboxMode !== 'danger-full-access') {
      const mode = makeModeRecommendation({
        setting: 'sandbox_mode',
        value: 'workspace-write',
        reason: `sandbox blocked ${sandboxSeen.count}x; workspace-write permits writes within the workspace`,
      });
      fragments.push(makeFragmentContract({ host: 'codex', rules: [], modeRecommendation: mode, notes: [] }));
      recommended.sandbox_mode = { value: 'workspace-write', reason: mode.reason };
      recommended.count += 1;
    }
    isolatedNotes.push('sandbox_mode="danger-full-access" removes the sandbox entirely — isolated-environment only, never a recommended default.');
  }

  // A trust recommendation needs a project to trust. `applicable: false` is a caller
  // with no project context (bootstrap composing this planner machine-globally), and it
  // must produce NO [projects] entry rather than a [projects."null"] header.
  const trustable = projectTrust?.applicable === true && typeof projectTrust.path === 'string' && projectTrust.path.length > 0;
  if ((approvalSeen || sandboxSeen) && !hostConfig.projectTrusted && trustable) {
    recommended.project_trust = { path_pointer: '.', trust_level: 'trusted', reason: 'first-use project trust reduces repeated prompts for this workspace' };
    recommended.count += 1;
    // Persist the project-trust intent in the combined artifact too (pointer-only;
    // Plan-verify peer MINOR — it was in the live report but not the artifact).
    artifactNotes.push('codex project-trust recommendation: [projects."."] trust_level=trusted');
  }

  const fragmentText = renderCodexConfigToml({
    approvalPolicy: recommended.approval_policy ? recommended.approval_policy.value : null,
    sandboxMode: recommended.sandbox_mode ? recommended.sandbox_mode.value : null,
    projectTrust: recommended.project_trust ? { path: projectTrust.path, trust_level: 'trusted' } : null,
  });
  const fragmentStruct = {
    config_toml: {
      approval_policy: recommended.approval_policy ? recommended.approval_policy.value : null,
      sandbox_mode: recommended.sandbox_mode ? recommended.sandbox_mode.value : null,
    },
    project_trust: recommended.project_trust ? { path_pointer: '.', trust_level: 'trusted' } : null,
  };

  const capNote = capNoteFor(scan, maxFiles);

  return {
    section: {
      requested: true,
      executed: true,
      status: codexHasEvidence ? 'analyzed' : 'baseline',
      host: 'codex',
      sources_scanned: {
        found: scan.found,
        used: scan.used,
        scan_truncated: scan.scan_truncated,
        skipped_too_large: scan.skipped_too_large,
      },
      host_config: {
        read_only: true,
        sources: hostConfig.sources,
        approval_policy: hostConfig.approvalPolicy,
        sandbox_mode: hostConfig.sandboxMode,
        project_trusted: hostConfig.projectTrusted,
      },
      recommended,
      isolated_environment_notes: isolatedNotes,
      evidence: {
        rule_count: codexRules.length,
        total_seen: codexRules.reduce((sum, rule) => sum + rule.evidence.count, 0),
        baseline_used: !codexHasEvidence,
      },
      fragment: fragmentStruct,
      fragment_text: fragmentText,
      limits: codexPermissionPlanLimits(capNote),
    },
    fragmentContracts: fragments,
    artifactNotes,
  };
}

// The dual blocked plan: usage-record enumeration failed, so neither host has evidence
// and no artifact is written. Both sections still render fully — a blocked plan that
// omitted its shape would read as "nothing to recommend".
function blockedSections(reason) {
  const blocked = (host, extra) => ({
    requested: true,
    executed: true,
    status: 'blocked',
    host,
    error: reason,
    sources_scanned: { found: 0, used: 0, scan_truncated: false, skipped_too_large: 0 },
    ...extra,
    artifact: { written: false, reason: 'usage-record enumeration failed' },
  });
  return {
    claude: blocked('claude', {
      host_config: { read_only: true, sources: [], default_mode: null },
      recommended: { allow: [], deny: [], ask: [], default_mode: null, count: 0 },
      conflicts: [],
      already_allowed_count: 0,
      fragment: null,
      fragment_text: null,
      evidence: { rule_count: 0, total_seen: 0, baseline_used: true },
      limits: permissionPlanLimits(null),
    }),
    codex: blocked('codex', {
      host_config: { read_only: true, sources: [], approval_policy: null, sandbox_mode: null, project_trusted: false },
      recommended: { approval_policy: null, sandbox_mode: null, project_trust: null, count: 0 },
      isolated_environment_notes: [],
      fragment: null,
      fragment_text: null,
      evidence: { rule_count: 0, total_seen: 0, baseline_used: true },
      limits: codexPermissionPlanLimits(null),
    }),
  };
}

/**
 * Build both host sections + the combined advisory artifact from already-gathered
 * facts. Synchronous and deterministic: same `gathered` + same injected clock/run-id →
 * identical output. Takes no repoRoot, so it cannot write into a consumer repository.
 *
 * Returns `{ claude, codex, artifact }` where `artifact` is the frozen, validated
 * advisory record ready for `writePermissionAdvisoryArtifact` — or null on the blocked
 * path, where the sections carry their own `artifact: { written: false }` marker and
 * there is nothing to persist.
 */
export function buildPermissionPlanSection({ gathered, now = new Date(), runId, runtimeVersion = RUNTIME_VERSION }) {
  if (gathered.scanError) {
    return { ...blockedSections(gathered.scanError), artifact: null };
  }

  const { learner, scanned, claudeHostConfig, codexHostConfig, maxFiles, projectTrust } = gathered;
  const claudeBuilt = buildClaudeSection({
    hostConfig: claudeHostConfig,
    learner,
    scan: scanned.claude,
    maxFiles,
  });
  const codexBuilt = buildCodexSection({
    hostConfig: codexHostConfig,
    projectTrust,
    learner,
    scan: scanned.codex,
    maxFiles,
  });

  const fragments = [];
  if (claudeBuilt.fragmentContract) fragments.push(claudeBuilt.fragmentContract);
  fragments.push(...codexBuilt.fragmentContracts);
  const artifactNotes = [...claudeBuilt.artifactNotes, ...codexBuilt.artifactNotes];

  // The sanitizing constructor is pure, so the artifact is built here and persisted by
  // the caller — the §1.3 "pure build + injected persist" split, using the constructor
  // permission-artifacts.mjs already owns rather than a second hand-rolled shape.
  const artifact = makePermissionAdvisoryArtifact({
    runId,
    surface: 'settings',
    hosts: ['claude', 'codex'],
    plan: fragments,
    evidence: learner,
    notes: artifactNotes,
    runtimeVersion,
    createdAt: now.toISOString(),
  });

  return { claude: claudeBuilt.section, codex: codexBuilt.section, artifact };
}

// ---------------------------------------------------------------------------
// The composed wrapper
// ---------------------------------------------------------------------------

/**
 * Orchestrate the cross-host M1 permission plan: gather once (collect usage records,
 * learn combined evidence, read both host configs), build both sections purely, and
 * write ONE cross-host advisory artifact (hosts: ['claude','codex']) so both sections
 * share a single run id + latest pointer (Plan-verify peer MAJOR — per-host artifacts
 * clobbered the single shared latest.json).
 */
export async function buildCrossHostPermissionPlan({ repoRoot, homeDir, env, now, maxFiles, maxFileBytes }) {
  const gathered = await gatherPermissionPlanInputs({ repoRoot, homeDir, env, maxFiles, maxFileBytes });
  const runId = makePermissionRunId(now);
  const built = buildPermissionPlanSection({ gathered, now, runId });

  if (!built.artifact) {
    return { claude: built.claude, codex: built.codex };
  }

  const pointers = await writePermissionAdvisoryArtifact({ repoRoot, artifact: built.artifact });
  const artifact = {
    written: true,
    run_id: runId,
    run_pointer: pointers.run_pointer,
    report_pointer: pointers.report_pointer,
    latest_pointer: pointers.latest_pointer,
  };

  return {
    claude: { ...built.claude, artifact },
    codex: { ...built.codex, artifact },
  };
}
