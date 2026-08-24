// plugins/runtime/scripts/lib/statusline-plan.mjs
//
// ADR-0048 §1/§2/§2.1 — the statusline stage's ONE canonical policy
// definition and every rendered form of it. This module owns:
//
//   1. the AGENTIC-6 POLICY — the owner-adopted six-item ordered set
//      (§2.1: model-with-reasoning · git-branch · pull-request-number ·
//      context-used · five-hour-limit · weekly-limit; version items excluded
//      by owner direction). One frozen table; the Codex fragment, the Claude
//      shim, the exact probes, and the profile preset all derive from it —
//      drift between renderers is §2's NAMED failure mode, so there is one
//      definition to drift from;
//   2. the INLINE SUFFICIENCY GATE (§2) — an executable five-condition
//      verdict, not prose: the inline `statusLine.command` form is allowed
//      only when every condition holds, and the agentic-6 policy FAILS it
//      (conditions 3/4 — cross-shell identity and one-command reviewability
//      of a six-field JSON projection), which is why the shim path is the
//      §2-documented outcome rather than a choice;
//   3. both Claude render modes — the inline command (for a policy that
//      passes the gate) and the SHIM fragment + rendered shim body (for one
//      that does not) — plus the Codex `[tui].status_line` fragment through
//      the one shared [tui] composer (lib/toml.mjs);
//   4. the pre-existing-statusLine CLASSIFICATION (§2) — an OBSERVATION
//      (absent | canonical | foreign-command | foreign-shape | unreadable)
//      plus the OFFERED resolutions (replace | manual-merge | decline). The
//      resolution itself is the operator's, recorded through the ordinary
//      answers/decline machinery — a foreign command cannot classify its own
//      fate, and nothing is ever auto-chained. "Manual merge" means keeping
//      compatible statusLine fields (padding, refreshInterval) while ending
//      with ONE canonical command — never chaining commands.
//
// Cross-shell command form (Plan-verify peer): the Claude `statusLine.command`
// runs through a SHELL (Git Bash when installed, PowerShell otherwise —
// host-truth §2), unlike Codex's shell-less notify spawn — so `node` resolves
// via PATH on both shells and no per-OS execPath split is needed here (the
// documented asymmetry with expectedCodexNotifyArgv). The path is always
// forward-slash (Git Bash eats unquoted backslashes) and SINGLE-quoted —
// literal in both Git Bash and PowerShell; double quotes interpolate in both
// (Review peer BLOCKER: `$(...)`/backticks in a home path would execute).
//
// Deliberately NOT here: file I/O (bootstrap gathers/persists), step
// judgement (bootstrap's judgeSteps), and the shim's per-item projections
// (the shim template owns them; the agreement test pins that the policy ids
// and the template's renderer map match, so a policy item the shim cannot
// render fails the suite, not the operator's statusline).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATUSLINE_PRESET_AGENTIC_6 } from './machine-profile.mjs';
import { substituteOnce } from './notification-plan.mjs';
import { resolveContainedSync } from './path-containment.mjs';
import { RUNTIME_VERSION } from '../version.mjs';
import { renderCodexTuiTableToml } from './toml.mjs';

export { STATUSLINE_PRESET_AGENTIC_6 };

export const STATUSLINE_SHIM_BASENAME = 'agentic-statusline.mjs';
export const STATUSLINE_SHIM_INSTALL_DIR_POINTER = '~/.agentic-plugins/bin';

// ---------------------------------------------------------------------------
// 1. The one policy definition (§2.1)
// ---------------------------------------------------------------------------

// Each row: the Codex item id (verbatim from the closed [tui].status_line
// vocabulary — host-truth §1 pins all six exist at 0.145.0) and the Claude
// stdin projection the shim renders (documentation of the §2.1 field mapping;
// the shim template implements it, the agreement test binds them).
export const STATUSLINE_POLICY_AGENTIC_6 = Object.freeze([
  Object.freeze({ id: 'model-with-reasoning', claude_projection: 'model.display_name + effort.level' }),
  Object.freeze({ id: 'git-branch', claude_projection: 'worktree.branch, else one bounded read-only `git branch --show-current` (owner-approved §2.1 deviation)' }),
  Object.freeze({ id: 'pull-request-number', claude_projection: 'pr.number' }),
  Object.freeze({ id: 'context-used', claude_projection: 'context_window.used_percentage' }),
  Object.freeze({ id: 'five-hour-limit', claude_projection: 'rate_limits.five_hour.used_percentage' }),
  Object.freeze({ id: 'weekly-limit', claude_projection: 'rate_limits.seven_day.used_percentage' }),
]);

/** The exact ordered Codex item-id array — the fragment's AND the probe's value. */
export function expectedCodexStatusLineItems(policy = STATUSLINE_POLICY_AGENTIC_6) {
  return policy.map((item) => item.id);
}

// ---------------------------------------------------------------------------
// 2. The inline sufficiency gate (§2) — executable, fail-closed
// ---------------------------------------------------------------------------

/**
 * Evaluate the five §2 conditions for rendering a policy as an INLINE
 * `statusLine.command`. Returns every per-condition verdict plus the
 * aggregate; unknown/unevaluable is false (fail-closed). The thresholds are
 * deliberately conservative: one stdin field, no subprocess, and a command
 * short enough to eyeball is what "review as one exact command" means.
 */
export function evaluateInlineSufficiency(policy = STATUSLINE_POLICY_AGENTIC_6) {
  const items = [...policy];
  const needsSubprocess = items.some((item) => /git branch/.test(item.claude_projection));
  const conditions = [
    {
      id: 'bounded-stdin-projection',
      holds: items.length > 0 && !needsSubprocess,
      detail: needsSubprocess ? 'the git-branch item needs a subprocess, not a stdin projection' : 'projects host-provided stdin JSON only',
    },
    {
      id: 'no-filesystem-or-plugin-state',
      holds: !needsSubprocess,
      detail: needsSubprocess ? 'the git-branch fallback reads the repository' : 'no filesystem or plugin-state lookup',
    },
    {
      id: 'identical-cross-shell',
      // A one-field extraction can be written shell-identically; a multi-field
      // JSON projection cannot be (quoting divergence between Git Bash and
      // PowerShell around embedded quotes/braces).
      holds: items.length <= 1,
      detail: items.length <= 1 ? 'single-field extraction is shell-identical' : `${items.length} fields need quoting that diverges between Git Bash and PowerShell`,
    },
    {
      id: 'reviewable-as-one-command',
      holds: items.length <= 2,
      detail: items.length <= 2 ? 'short enough to review inline' : `${items.length} projected fields exceed one reviewable command`,
    },
    {
      id: 'no-chaining',
      // The renderers below never chain — this condition guards a FUTURE
      // policy that would wrap an existing command; structurally true here.
      holds: true,
      detail: 'renderers never chain a pre-existing or unknown command',
    },
  ];
  return { sufficient: conditions.every((c) => c.holds), conditions };
}

/**
 * Inline render for a policy that PASSES the gate — kept honest by the gate:
 * callers must refuse to inline a policy the gate rejects. Single-field only
 * (the only shape condition 3 admits): a `node -e` one-liner projecting one
 * stdin field, double-quoted for cross-shell grouping.
 */
export function renderInlineClaudeCommand(policy) {
  const verdict = evaluateInlineSufficiency(policy);
  if (!verdict.sufficient) {
    throw new Error(`refusing to render an inline statusline command: the policy fails the §2 sufficiency gate (${verdict.conditions.filter((c) => !c.holds).map((c) => c.id).join(', ')})`);
  }
  if (policy.length !== 1 || policy[0].id !== 'model-with-reasoning') {
    throw new Error('inline rendering currently supports exactly the single-item model policy');
  }
  // require-free on purpose: the ADR-0035 §4 executor guard reads string
  // literals too (argv hazards live in strings) and a require() spelled
  // inside this command reads as a dynamic-import hazard. Pure stdin events
  // need no module at all.
  return 'node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>{try{const m=JSON.parse(s)?.model?.display_name;if(m)console.log(m)}catch{}})"';
}

// ---------------------------------------------------------------------------
// 3. Rendered forms
// ---------------------------------------------------------------------------

/** Forward-slash absolute shim install path for this home. */
export function statuslineShimInstallPath({ homeDir }) {
  return join(homeDir, '.agentic-plugins', 'bin', STATUSLINE_SHIM_BASENAME).replace(/\\/g, '/');
}

/**
 * The canonical Claude `statusLine.command` for this machine — the exact
 * probe's and the settings fragment's shared value.
 *
 * SINGLE-quoted (Review peer BLOCKER): double quotes interpolate in BOTH
 * Git Bash and PowerShell, so a home like `C:\Users\$(whoami)` would execute
 * substitution and change the shim argv. Single quotes are literal in both
 * shells. A path that itself contains a single quote cannot be represented
 * cross-shell-identically and is refused fail-closed.
 */
export function expectedClaudeStatuslineCommand({ homeDir }) {
  const path = statuslineShimInstallPath({ homeDir });
  if (path.includes("'")) {
    throw new Error('the shim install path contains a single quote, which has no cross-shell-literal representation (Git Bash vs PowerShell) — relocate the home or configure the statusline manually');
  }
  return `node '${path}'`;
}

/** The settings.json fragment (rendered text the operator merges). */
export function renderClaudeStatuslineFragmentJson({ homeDir }) {
  return `${JSON.stringify({ statusLine: { type: 'command', command: expectedClaudeStatuslineCommand({ homeDir }) } }, null, 2)}\n`;
}

/** The Codex fragment — always through the one [tui] composer. */
export function renderCodexStatusLineFragmentToml(policy = STATUSLINE_POLICY_AGENTIC_6) {
  return renderCodexTuiTableToml({ statusLine: expectedCodexStatusLineItems(policy) });
}

const RECEIVERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'receivers');
const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECEIVER_API_BASENAME = 'receiver-api.mjs';

// Canonical containment, like every other packaged asset. This one renders
// CODE the operator is invited to install, so a template resolving outside the
// package would put content the package does not own into a script a person
// then runs — reproduced by cross-host review with an outside marker reaching
// the rendered shim.
function readPackagedStatuslineTemplate() {
  const located = resolveContainedSync(RECEIVERS_DIR, STATUSLINE_SHIM_BASENAME);
  if (located.status !== 'ok') {
    throw new Error(`statusline shim template could not be resolved inside the runtime package (${located.status}${located.code ? `: ${located.code}` : ''}) at ${located.path}`);
  }
  return readFileSync(located.canonicalPath, 'utf8');
}

function jsStringArrayLiteral(values) {
  if (!Array.isArray(values) || !values.every((item) => typeof item === 'string')) {
    throw new Error('statusline items literal requires an array of strings');
  }
  return `[${values.map((item) => JSON.stringify(item)).join(', ')}]`;
}

/**
 * Render the shim body from the packaged template, substituting the policy's
 * ordered item ids exactly once (template drift fails the render, never a
 * half-substituted script). Returns { body, sha256 } — the hash is presented
 * to the operator for their own install verification; it deliberately does
 * NOT gate the `statusline.claude.configured` step (settings-level
 * semantics; see the machine-bootstrap contract's statusline section).
 */
export function renderAgenticStatuslineShim({
  policy = STATUSLINE_POLICY_AGENTIC_6,
  template = null,
  minRuntimeVersion = RUNTIME_VERSION,
} = {}) {
  const source = template ?? readPackagedStatuslineTemplate();
  const withItems = substituteOnce(
    source,
    "['__AGENTIC_STATUSLINE_ITEMS__']",
    jsStringArrayLiteral(expectedCodexStatusLineItems(policy)),
    'STATUSLINE_ITEMS',
  );
  // The shim delegates to the packaged receiver API, so it carries a runtime
  // floor exactly as the Codex shuttle does (renderCodexNotifyShuttleScript).
  // substituteOnce is fail-closed on a missing or repeated token, so a template
  // that stopped carrying this placeholder fails the render rather than
  // shipping a shim whose floor is the literal placeholder — which versionGte
  // would parse as 0.0.0 and let EVERY runtime through the gate.
  const body = substituteOnce(
    withItems,
    "'__AGENTIC_MIN_RUNTIME_VERSION__'",
    JSON.stringify(String(minRuntimeVersion)),
    'MIN_RUNTIME_VERSION',
  );
  return { body, sha256: createHash('sha256').update(body).digest('hex') };
}

/**
 * The renderer-map ids the packaged shim template supports — parsed from the
 * template so the policy↔shim agreement test binds the two without executing
 * the shim. Fail-closed: an unparsable template returns [] and the agreement
 * test fails loudly.
 */
export function shimTemplateRendererIds({ source = null } = {}) {
  const text = source ?? readPackagedReceiverApi();
  const match = text.match(/const RENDERERS = \{([\s\S]*?)\n\};/);
  if (!match) return [];
  return [...match[1].matchAll(/^ {2}'([a-z0-9-]+)':/gm)].map((m) => m[1]);
}

// The renderer map moved OUT of the shim template and into the packaged API
// when the shim became a delegating one — the shim no longer knows any item.
// This reader follows it there, so the policy-agreement test keeps binding the
// policy to the code that actually renders, rather than passing vacuously
// against a template that no longer contains a renderer map.
function readPackagedReceiverApi() {
  const located = resolveContainedSync(SCRIPTS_DIR, RECEIVER_API_BASENAME);
  if (located.status !== 'ok') {
    throw new Error(`receiver API could not be resolved inside the runtime package (${located.status}${located.code ? `: ${located.code}` : ''}) at ${located.path}`);
  }
  return readFileSync(located.canonicalPath, 'utf8');
}

// ---------------------------------------------------------------------------
// 4. Pre-existing statusLine classification (§2)
// ---------------------------------------------------------------------------

export const STATUSLINE_OBSERVATIONS = Object.freeze(['absent', 'canonical', 'foreign-command', 'foreign-shape', 'unreadable']);
export const STATUSLINE_OFFERED_RESOLUTIONS = Object.freeze(['replace', 'manual-merge', 'decline']);

/**
 * Classify what the settings snapshot OBSERVES — never what the operator
 * should do about it. `existing` is the statusline projection of the shared
 * Claude settings reader: { readable, present, type, command }. The raw
 * foreign command is deliberately not echoed back (it may carry secrets or
 * private paths); observation strings summarize shape only.
 */
export function classifyExistingClaudeStatusline({ existing, expectedCommand }) {
  if (!existing || existing.readable === false) {
    return { observation: 'unreadable', offered_resolutions: [], note: 'the Claude settings file could not be read' };
  }
  if (!existing.present) {
    return { observation: 'absent', offered_resolutions: [], note: 'no statusLine is configured — the fragment installs fresh' };
  }
  if (existing.type === 'command' && existing.command === expectedCommand) {
    return { observation: 'canonical', offered_resolutions: [], note: 'the canonical agentic statusline command is already configured' };
  }
  if (existing.type === 'command') {
    return {
      observation: 'foreign-command',
      offered_resolutions: [...STATUSLINE_OFFERED_RESOLUTIONS],
      note: 'a different statusLine command is configured; runtime never auto-chains it — choose replace (the fragment), manual-merge (keep compatible fields such as padding/refreshInterval around the ONE canonical command), or decline the step',
    };
  }
  return {
    observation: 'foreign-shape',
    offered_resolutions: ['manual-merge', 'decline'],
    note: 'the existing statusLine is not a command-type entry this plan understands — merge manually or decline the step',
  };
}
