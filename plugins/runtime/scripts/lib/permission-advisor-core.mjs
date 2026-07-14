// Host-neutral permission-advisor core (ADR-0038 §1/§3/§5).
//
// The shared, host-NEUTRAL foundation for the runtime permission advisor.
// `runtime:doctor` (R0 diagnosis), `runtime:settings` (M1 Claude plan and
// M1 Codex plan), the usage-learner, and the permission-artifacts slice all
// consume THIS module. settings-claude and settings-codex are therefore
// SIBLINGS that both build on this core — neither is a downstream adapter of
// the other (the cross-host structural gap the Plan-verify peer flagged for
// the macro plan).
//
// This module owns four things and nothing host-specific:
//   1. the prompt-cause taxonomy (why a host interrupts, by host x mechanism);
//   2. the evidence/rule schema (the unit doctor reports and settings renders),
//      versioned + id'd so permission-artifacts/doctor can reject stale shapes;
//   3. the safety-grading table + grading function (allow / ask / deny);
//   4. the host-config fragment CONTRACT (a host-neutral envelope that the
//      settings-claude / settings-codex slices render into the exact
//      settings.json / config.toml text — the rendering lives there, not here).
//
// It is PURE: no fs, no child_process, no network, no env reads, no clock.
// It performs NO artifact writes and NO host-config access (ADR-0038 §3) and
// it ships NO permission-relaxing hook (ADR-0038 §6 / ADR-0035 §4). Those
// invariants are encoded as assertable constants below so every downstream
// slice imports the boundary from one place instead of restating it.
//
// Secret redaction and command->pattern generalization are delegated to the
// sanitize util (single source of truth). This core only classifies and
// shapes — it never re-implements either.
//
// SCOPE NOTE (deliberately deferred to the settings slices): the host-SPECIFIC
// rendering data — Claude permission-item kind (`Bash(...)` vs WebFetch domain
// vs `mcp__server__tool`), Codex `--profile` overlay, `[projects."<path>"]
// trust_level`, execpolicy entries — is NOT modeled as rule fields here. The
// `cause` + `remedy` pair is the host-neutral extension point; each settings
// slice derives its host-specific rendering from those. Adding host-shaped
// fields to this core would re-introduce the sibling-coupling this split exists
// to prevent.

import {
  singleLine,
  sanitizeValue,
  generalizeCommand,
  tokenizeCommand,
  stripEnvAssignments,
} from './permission-sanitize.mjs';

// Bumped when the rule/fragment shape changes incompatibly. permission-artifacts
// and doctor stamp/gate artifacts on this so a stale on-disk plan is rejected
// rather than mis-rendered (Plan-verify peer gap #2).
export const ADVISOR_SCHEMA_VERSION = '1.0';

// ---------------------------------------------------------------------------
// 1. Hosts + prompt-cause taxonomy
// ---------------------------------------------------------------------------

// The two first-class hosts (ADR-0001 cross-host parity, ADR-0038 §4).
export const ADVISOR_HOSTS = Object.freeze(['claude', 'codex']);

export function isAdvisorHost(host) {
  return ADVISOR_HOSTS.includes(host);
}

// The settings levers a recommended rule maps to. A closed enum (not a free
// string) so settings-claude and settings-codex reference one shared vocabulary
// and cannot drift (Plan-verify peer gap #5).
//   'allow-rule'      -> a per-pattern allow entry (Claude allow[] item; Codex
//                        execpolicy / granular per-category approval)
//   'default-mode'    -> a host-level mode (Claude defaultMode=acceptEdits)
//   'sandbox-mode'    -> Codex sandbox_mode
//   'approval-policy' -> Codex approval_policy
export const REMEDY_KINDS = Object.freeze([
  'allow-rule',
  'default-mode',
  'sandbox-mode',
  'approval-policy',
]);

// Prompt-cause taxonomy: the enumerated reasons a host interrupts work with a
// permission prompt, classified by host x mechanism (ADR-0038 §1). Each entry
// NAMES a host, but the taxonomy is the single shared registry both the doctor
// diagnosis and the settings plan read — that shared registry is what makes
// the surface host-neutral.
//
// Codex interrupts via exactly two CAUSES — the sandbox blocked the action, or
// the approval policy asked. The finer Codex levers the ADR names (execpolicy
// `.rules`, granular per-category approval, `--profile` overlay, project
// `trust_level`) are REMEDIES the settings-codex slice chooses, not separate
// causes — modeling them as causes here would conflate "why it prompted" with
// "how to fix it" (Plan-verify peer gap #3, resolved by the cause/remedy split).
export const PROMPT_CAUSES = Object.freeze({
  'claude.bash-not-allowlisted': Object.freeze({
    id: 'claude.bash-not-allowlisted',
    host: 'claude',
    mechanism: 'bash',
    title: 'Bash command is not on the settings allowlist',
    remedy: 'allow-rule',
  }),
  'claude.file-modification': Object.freeze({
    id: 'claude.file-modification',
    host: 'claude',
    mechanism: 'file-write',
    title: 'File modification (Edit/Write) outside acceptEdits',
    remedy: 'default-mode',
  }),
  'claude.webfetch-domain': Object.freeze({
    id: 'claude.webfetch-domain',
    host: 'claude',
    mechanism: 'webfetch',
    title: 'WebFetch to a domain that is not allowlisted',
    remedy: 'allow-rule',
  }),
  'claude.mcp-not-allowed': Object.freeze({
    id: 'claude.mcp-not-allowed',
    host: 'claude',
    mechanism: 'mcp',
    title: 'MCP tool is not allowlisted',
    remedy: 'allow-rule',
  }),
  'codex.sandbox-blocked': Object.freeze({
    id: 'codex.sandbox-blocked',
    host: 'codex',
    mechanism: 'sandbox',
    title: 'Action blocked by the Codex sandbox_mode',
    remedy: 'sandbox-mode',
  }),
  'codex.approval-requested': Object.freeze({
    id: 'codex.approval-requested',
    host: 'codex',
    mechanism: 'approval',
    title: 'Codex approval_policy requested confirmation',
    remedy: 'approval-policy',
  }),
});

// Every cause, or only those for one host. Returns a fresh array each call so
// callers cannot mutate the registry.
export function listPromptCauses(host) {
  const all = Object.values(PROMPT_CAUSES);
  if (host === undefined || host === null) return all.slice();
  return all.filter((cause) => cause.host === host);
}

export function getPromptCause(id) {
  return Object.prototype.hasOwnProperty.call(PROMPT_CAUSES, id)
    ? PROMPT_CAUSES[id]
    : null;
}

export function isPromptCause(id) {
  return getPromptCause(id) !== null;
}

// ---------------------------------------------------------------------------
// 2. Safety-grading table + grading function
// ---------------------------------------------------------------------------

// The three recommendation grades. Severity order (worst first): deny > ask >
// allow. The advisor recommends `allow` only for command families it can
// positively classify as safe; everything unrecognized falls to the
// conservative `ask` (surface to the user, do NOT broadly allow); genuinely
// dangerous shapes are graded `deny` or held at `ask`.
export const SAFETY_GRADES = Object.freeze(['allow', 'ask', 'deny']);

const GRADE_SEVERITY = Object.freeze({ allow: 0, ask: 1, deny: 2 });

export function isSafetyGrade(grade) {
  return SAFETY_GRADES.includes(grade);
}

// Returns the more severe of two grades (deny beats ask beats allow).
export function worstGrade(a, b) {
  const sa = GRADE_SEVERITY[a] ?? 0;
  const sb = GRADE_SEVERITY[b] ?? 0;
  return sa >= sb ? a : b;
}

// Programs that are read-only / inspection-only (or the project's core dev
// runtimes invoked on a SCRIPT FILE) and safe to recommend a broad allow for.
// This is the "broad proactive allow pattern" ADR-0038 §root-cause(a) endorses.
// The language runtimes can run arbitrary code via an inline-eval flag
// (`node -e`, `python3 -c`), but that form is intercepted by the inline-eval
// danger rule BELOW before this set is consulted, so `node script.mjs` allows
// while `node -e "..."` does not (Plan-verify peer gap #6).
const ALWAYS_SAFE_PROGRAMS = new Set([
  // read-only / inspection
  'ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'wc', 'grep', 'rg', 'fd',
  'find', 'which', 'env', 'printenv', 'date', 'dirname', 'basename',
  'realpath', 'readlink', 'jq', 'yq', 'sort', 'uniq', 'cut', 'tr', 'diff',
  'tree', 'stat', 'file', 'printf', 'true', 'false', 'whoami', 'hostname',
  'uname', 'id', 'groups', 'df', 'du', 'ps', 'sleep', 'test', 'seq', 'tac',
  'column', 'nl', 'comm', 'join', 'paste', 'fold', 'expand',
  // core dev runtimes (broad-allow for the script-file form per §root-cause(a))
  'node', 'deno', 'python', 'python3', 'ruby', 'perl', 'tsx', 'ts-node',
]);

// GENUINELY read-only git subcommands only. Dual-use subcommands (branch, tag,
// remote, config, worktree, stash, symbolic-ref, reflog) are deliberately
// EXCLUDED: because grading keys on the subcommand token and the recommended
// rule generalizes the args away, including `branch` would broadly allow
// `git branch -D`, `tag` would allow `git tag -d`, etc. (Plan-verify peer
// gap #7). Excluded subcommands fall to `ask`.
const SAFE_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'fetch', 'blame',
  'shortlog', 'ls-files', 'ls-remote', 'for-each-ref', 'cat-file',
  'merge-base', 'name-rev', 'rev-list', 'show-ref', 'whatchanged', 'grep',
]);

// Per-wrapper safe subcommand sets. A wrapper program with a listed
// subcommand grades `allow`; an unlisted subcommand (e.g. `npm publish`,
// `cargo yank`, `go install`) falls to `ask`. Members are data, so refining
// the policy is a data edit, not a logic change.
const WRAPPER_SAFE_SUBCOMMANDS = new Map([
  ['npm', new Set(['run', 'test', 'ci', 'install', 'i', 'add', 'remove', 'rm',
    'uninstall', 'ls', 'list', 'exec', 'why', 'outdated', 'audit', 'version',
    'view', 'info', 'start', 'build', 'dev', 'lint', 'prune', 'dedupe',
    'ping', 'doctor', 'help', 'pkg', 'fund'])],
  ['pnpm', new Set(['run', 'test', 'install', 'i', 'add', 'remove', 'rm',
    'ls', 'list', 'exec', 'why', 'outdated', 'audit', 'start', 'build',
    'dev', 'lint', 'prune', 'dedupe', 'doctor', 'help'])],
  ['yarn', new Set(['run', 'test', 'install', 'add', 'remove', 'list',
    'why', 'outdated', 'audit', 'start', 'build', 'dev', 'lint', 'dedupe',
    'info', 'help'])],
  ['bun', new Set(['run', 'test', 'install', 'i', 'add', 'remove', 'rm',
    'build', 'dev', 'outdated', 'why', 'help'])],
  ['cargo', new Set(['build', 'test', 'run', 'check', 'clippy', 'fmt',
    'doc', 'tree', 'update', 'fetch', 'metadata', 'version', 'add',
    'remove', 'bench', 'clean', 'help'])],
  ['go', new Set(['build', 'test', 'run', 'vet', 'fmt', 'doc', 'version',
    'mod', 'list', 'env', 'work', 'tool', 'generate', 'clean', 'help'])],
  ['pip', new Set(['list', 'show', 'freeze', 'check', 'download', 'help'])],
  ['pip3', new Set(['list', 'show', 'freeze', 'check', 'download', 'help'])],
  ['poetry', new Set(['run', 'install', 'show', 'check', 'lock', 'version',
    'build', 'env', 'about', 'help'])],
]);

// Replace single/double-quoted spans with a neutral placeholder BEFORE any
// danger detection or tokenizing, so quoted content (a commit message
// containing "rm -rf", a string literal holding "curl | bash") cannot trigger
// a danger rule and poison the generalized pattern (Plan-verify peer gap #8 /
// AGREED). An unbalanced trailing quote is treated as opening a span that runs
// to end-of-line. Trade-off (peer-noted): the inline-eval rule, not arg
// scanning, is what catches `bash -c "<hidden>"` — the `-c` flag is outside the
// quotes and remains visible.
// The placeholder MUST NOT itself contain a quote character. It used to be
// `"_"`, which the unbalanced-trailing-quote passes below then re-read as an
// OPENING quote and swallowed to end-of-line — taking the rest of the command
// with it. `TOKEN="a b" rm -rf /` collapsed to `TOKEN= "_ "_"`, and
// `echo "hi" && rm -rf /` collapsed to `echo "_ "_"`, so the danger rules never
// saw the `rm -rf` at all and the command graded `allow`. That is a danger-rule
// bypass, not a cosmetic defect: the advisor would then recommend the pattern
// into the operator's allowlist. A quote-free placeholder cannot be mistaken
// for an opening quote, so the balanced-span pass and the unbalanced-tail pass
// stop interfering with each other.
const QUOTED_SPAN_PLACEHOLDER = ' _Q_ ';

function stripQuoted(cmd) {
  return cmd
    .replace(/"[^"]*"/g, QUOTED_SPAN_PLACEHOLDER)
    .replace(/'[^']*'/g, QUOTED_SPAN_PLACEHOLDER)
    // Whatever quote survives the balanced passes is genuinely unbalanced, so
    // it does open a span that runs to end-of-line.
    .replace(/"[^"]*$/g, QUOTED_SPAN_PLACEHOLDER)
    .replace(/'[^']*$/g, QUOTED_SPAN_PLACEHOLDER)
    .replace(/\s+/g, ' ')
    .trim();
}

// Split a (quote-stripped) command line into its top-level segments on the
// shell control operators && || ; | . Single `&` is intentionally NOT a split
// point, so an `2>&1` fd-redirect is never mis-split. Each segment is then
// graded independently and the worst grade wins — so `ls | wc -l` stays allow
// (both safe) while `git status && git commit` becomes ask (commit not safe),
// precisely fixing the first-token-only blind spot (AGREED / peer gap #6)
// without bluntly downgrading every pipe.
function splitSegments(stripped) {
  return stripped
    .split(/\s*(?:\|\||&&|;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Detect a short clustered flag (e.g. -rf / -Rf contains both r and f) OR a
// long flag (--force). Only the portion BEFORE a standalone `--` end-of-options
// token is scanned, so `rm -r -- -f` (a file literally named `-f`) is not
// misread as `rm -rf` (Plan-verify peer gap #13). Short flags are only matched
// after start/whitespace, so a hyphen inside a token is never a false positive.
function flagScope(cmd) {
  const m = cmd.match(/(^|\s)--(\s|$)/);
  return m ? cmd.slice(0, m.index) : cmd;
}

function matchesShortFlag(cmd, shortChar) {
  const scope = flagScope(cmd);
  const re = /(?:^|\s)-([a-zA-Z]+)\b/g;
  const target = shortChar.toLowerCase();
  let m;
  while ((m = re.exec(scope)) !== null) {
    if (m[1].toLowerCase().includes(target)) return true;
  }
  return false;
}

function hasFlag(cmd, shortChar, longName) {
  const scope = flagScope(cmd);
  if (longName && new RegExp(`--${longName}\\b`, 'i').test(scope)) return true;
  return shortChar ? matchesShortFlag(cmd, shortChar) : false;
}

// Whole-command danger rules: matched against the full quote-stripped command
// because they need cross-segment context the splitter would destroy
// (`curl ... | bash`; the `:|:` of a fork bomb).
const WHOLE_COMMAND_DANGER_RULES = Object.freeze([
  {
    id: 'pipe-to-shell',
    grade: 'deny',
    title: 'remote download piped directly into a shell',
    match: (cmd) =>
      /\b(curl|wget|fetch)\b/i.test(cmd) &&
      /\|\s*(sudo\s+)?(bash|sh|zsh|dash|fish|ksh|csh|tcsh)\b/i.test(cmd),
  },
  {
    id: 'fork-bomb',
    grade: 'deny',
    title: 'fork bomb',
    match: (cmd) => /:\s*\(\s*\)\s*\{/.test(cmd) && /:\s*\|\s*:/.test(cmd),
  },
  {
    id: 'command-substitution',
    grade: 'ask',
    title: 'command substitution runs an un-graded nested command',
    match: (cmd) => /\$\(|`/.test(cmd),
  },
]);

// Per-segment danger rules: matched against one command segment. Ordered
// deny-first; the grader collects all matches and reports the worst grade.
const SEGMENT_DANGER_RULES = Object.freeze([
  {
    id: 'rm-recursive-force',
    grade: 'deny',
    title: 'recursive force remove (rm -rf)',
    match: (seg) =>
      /\brm\b/i.test(seg) && hasFlag(seg, 'r', 'recursive') && hasFlag(seg, 'f', 'force'),
  },
  {
    id: 'rm-no-preserve-root',
    grade: 'deny',
    title: 'rm --no-preserve-root',
    match: (seg) => /\brm\b[^|;&]*--no-preserve-root\b/i.test(seg),
  },
  {
    id: 'raw-disk-write',
    grade: 'deny',
    title: 'raw disk / filesystem write (dd, mkfs, fdisk, >/dev/<disk>)',
    match: (seg) =>
      /\b(dd|mkfs(\.[a-z0-9]+)?|fdisk|sfdisk|parted|wipefs)\b/i.test(seg) ||
      />\s*\/dev\/(sd|nvme|hd|disk|mmcblk)/i.test(seg),
  },
  {
    id: 'inline-eval-exec',
    grade: 'ask',
    title: 'inline code evaluation / arbitrary execution',
    match: (seg) =>
      /\b(node|deno|bun)\b.*\s-(?:e|-eval|p|-print)\b/i.test(seg) ||
      /\b(python|python3|ruby|perl|php)\b.*\s-(?:c|e|E)\b/i.test(seg) ||
      /\b(sh|bash|zsh|dash|ksh|csh|tcsh|fish)\b.*\s-c\b/i.test(seg) ||
      /\bfind\b.*\s-(?:delete|exec|execdir|fprint|ok)\b/i.test(seg) ||
      /(?:^|\s)(eval|xargs)\b/i.test(seg),
  },
  {
    id: 'redirect-write',
    grade: 'ask',
    title: 'output redirected to a file (write)',
    // A `>` / `>>` whose target is a real file: not a /dev/ pseudo-device and
    // not an `&`-fd duplication. The `(?:^|\s)` guard skips `2>&1`-style fd
    // redirects (the `>` is preceded by a digit, not start/whitespace).
    match: (seg) => /(?:^|\s)>>?\s*(?!\/dev\/|&)\S/.test(seg),
  },
  {
    id: 'git-history-destruction',
    grade: 'ask',
    title: 'history-rewriting / destructive git',
    match: (seg) =>
      /\bgit\b/i.test(seg) &&
      ((/\bpush\b/i.test(seg) && hasFlag(seg, 'f', 'force')) ||
        /\bpush\b[^|;&]*--mirror\b/i.test(seg) ||
        /\breset\b[^|;&]*--hard\b/i.test(seg) ||
        (/\bclean\b/i.test(seg) && matchesShortFlag(seg, 'f')) ||
        /\bfilter-branch\b/i.test(seg)),
  },
  {
    id: 'privilege-escalation',
    grade: 'ask',
    title: 'privilege escalation (sudo / doas / su)',
    match: (seg) =>
      /(?:^|\s)(sudo|doas)\b/i.test(seg) || /(?:^|\s)su\b(\s|$)/i.test(seg),
  },
  {
    id: 'permissive-chmod',
    grade: 'ask',
    title: 'world-writable / permissive chmod',
    match: (seg) => /\bchmod\b[^|;&]*(777|666|[oa]\+w)/i.test(seg),
  },
  {
    id: 'git-internal-write',
    grade: 'ask',
    title: 'write into .git internals',
    match: (seg) =>
      /(>>?|\btee\b|\bcp\b|\bmv\b|\brm\b|\btruncate\b)[^|;&]*\.git\//i.test(seg),
  },
  {
    id: 'secret-file-write',
    grade: 'ask',
    title: 'write to a secret-bearing file',
    match: (seg) =>
      /(>>?|\btee\b|\bcp\b|\bmv\b)[^|;&]*(\.env\b|\.pem\b|\.key\b|\.p12\b|\.pfx\b|id_rsa\b|id_ed25519\b|credentials\b|\.npmrc\b|\.netrc\b)/i.test(
        seg,
      ),
  },
]);

function gradeResult(grade, reason, signals = []) {
  return Object.freeze({ grade, reason, signals: Object.freeze(signals.slice()) });
}

// Classify ONE command segment (no top-level operators). Returns
// { grade, signals[], reason }. Danger rules run first; otherwise the leading
// program (after any `VAR=val` env prefix) is classified by family.
function gradeSegment(seg) {
  const matched = [];
  for (const rule of SEGMENT_DANGER_RULES) {
    let hit = false;
    try {
      hit = rule.match(seg);
    } catch {
      hit = false;
    }
    if (hit) matched.push(rule);
  }
  if (matched.length) {
    let grade = 'allow';
    for (const rule of matched) grade = worstGrade(grade, rule.grade);
    const chosen = matched.find((rule) => rule.grade === grade) || matched[0];
    return { grade, signals: matched.map((m) => m.id), reason: chosen.title };
  }

  // Drop leading `FOO=bar` / `FOO="a b"` env-assignment prefixes to find the
  // real program. This used to re-implement `split(' ')` + an assignment strip
  // locally, which tore a quoted value containing a space in half and promoted
  // its orphaned tail into the program slot — so `TOKEN="a b" rm -rf /` graded
  // `ask` (unrecognized program) instead of `deny`. The tokenizer now lives
  // once in permission-sanitize.mjs and both call sites share it; the
  // duplication is what let the same defect survive two separate hardenings.
  const { tokens: rawTokens } = tokenizeCommand(seg);
  const tokens = stripEnvAssignments(rawTokens);
  const program = tokens[0] || '';
  const sub = tokens[1];
  // reason embeds the program name; sanitize it so a secret-shaped token can
  // never leak through a diagnostic reason string (local finding D).
  const safeProgram = sanitizeValue(program) || '(none)';

  if (!program) return { grade: 'ask', signals: [], reason: 'empty segment' };
  if (ALWAYS_SAFE_PROGRAMS.has(program)) {
    return { grade: 'allow', signals: [], reason: `known-safe program '${safeProgram}'` };
  }
  if (program === 'git') {
    if (sub && SAFE_GIT_SUBCOMMANDS.has(sub)) {
      return { grade: 'allow', signals: [], reason: `read-only git subcommand 'git ${sanitizeValue(sub)}'` };
    }
    return { grade: 'ask', signals: [], reason: `git subcommand '${sanitizeValue(sub) || '(none)'}' is not in the read-only safe set` };
  }
  if (WRAPPER_SAFE_SUBCOMMANDS.has(program)) {
    const safe = WRAPPER_SAFE_SUBCOMMANDS.get(program);
    if (sub && safe.has(sub)) {
      return { grade: 'allow', signals: [], reason: `safe ${safeProgram} subcommand '${safeProgram} ${sanitizeValue(sub)}'` };
    }
    return { grade: 'ask', signals: [], reason: `${safeProgram} subcommand '${sanitizeValue(sub) || '(none)'}' is not in its safe set` };
  }
  return { grade: 'ask', signals: [], reason: `unrecognized program '${safeProgram}' — conservative ask (not broadly allowed)` };
}

// Grade a raw shell command into a recommendation. Returns
// { grade, reason, signals[] }, where signals are the danger-rule ids that
// fired. Pure and total: never throws, always returns a valid grade — an
// empty/unparseable command grades `ask`.
//
// Quotes are neutralized first, whole-command danger rules run on the result,
// then every operator-separated segment is graded and the worst grade wins.
// This is the safety judgement the sanitize util deliberately does NOT make
// (generalizeCommand is pure mechanism). doctor, the usage-learner, and both
// settings slices call THIS so they grade identically.
export function gradeCommand(rawCommand) {
  const stripped = stripQuoted(singleLine(rawCommand));
  if (!stripped) {
    return gradeResult('ask', 'empty or unparseable command');
  }

  let grade = 'allow';
  const signals = [];
  let reason = '';

  for (const rule of WHOLE_COMMAND_DANGER_RULES) {
    let hit = false;
    try {
      hit = rule.match(stripped);
    } catch {
      hit = false;
    }
    if (hit) {
      grade = worstGrade(grade, rule.grade);
      signals.push(rule.id);
      if (rule.grade === grade) reason = rule.title;
    }
  }

  for (const seg of splitSegments(stripped)) {
    const segResult = gradeSegment(seg);
    const before = grade;
    grade = worstGrade(grade, segResult.grade);
    if (segResult.signals.length) signals.push(...segResult.signals);
    // Adopt the reason from whichever evaluation set the current worst grade.
    if (grade !== before || (!reason && grade === segResult.grade)) {
      reason = segResult.reason;
    }
  }

  if (!reason) reason = 'no unsafe signal detected';
  return gradeResult(grade, reason, signals);
}

// ---------------------------------------------------------------------------
// 3. Evidence + rule schema
// ---------------------------------------------------------------------------

// Where a rule's evidence came from. 'usage' = grounded in observed prompt
// events (the C engine "seen N times"); 'baseline' = the conservative
// known-safe fallback used when no usage record is available (ADR-0038 §2).
export const EVIDENCE_SOURCES = Object.freeze(['usage', 'baseline']);

// Build a validated, frozen evidence record. count is coerced to a
// non-negative integer; an unknown source defaults to 'baseline' (the
// conservative side); note is sanitized so no raw transcript text survives.
export function makeEvidence({ count = 0, source = 'baseline', note = null } = {}) {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  const src = EVIDENCE_SOURCES.includes(source) ? source : 'baseline';
  return Object.freeze({
    count: n,
    source: src,
    note: note === null || note === undefined ? null : sanitizeValue(note),
  });
}

// Stable, deterministic rule id — a dedup/lookup key for permission-artifacts
// and doctor (Plan-verify peer gap #2). Derived from the identifying triple.
function ruleId(host, cause, pattern) {
  return `${host}|${cause}|${pattern}`;
}

// Build a validated, frozen recommended rule — the unit doctor reports and the
// settings slices render. Throws on an invalid host / cause / grade so a
// malformed rule never reaches an artifact. The pattern is the GENERALIZED
// pattern (caller passes generalizeCommand output, or uses
// makeCommandRuleFromObservation which does it in the safe order); it is re-run
// through sanitizeValue here as defense-in-depth so a secret can never survive
// into a rule even if a caller forgot to generalize first (ADR-0038 §5).
export function makeRule({ host, cause, pattern, grade, reason = null, evidence = null }) {
  if (!isAdvisorHost(host)) {
    throw new Error(`makeRule: unknown host '${host}' (expected one of ${ADVISOR_HOSTS.join(', ')})`);
  }
  if (!isPromptCause(cause)) {
    throw new Error(`makeRule: unknown prompt cause '${cause}'`);
  }
  if (getPromptCause(cause).host !== host) {
    throw new Error(`makeRule: cause '${cause}' belongs to host '${getPromptCause(cause).host}', not '${host}'`);
  }
  if (!isSafetyGrade(grade)) {
    throw new Error(`makeRule: invalid grade '${grade}' (expected one of ${SAFETY_GRADES.join(', ')})`);
  }
  const safePattern = sanitizeValue(pattern);
  if (!safePattern) {
    throw new Error('makeRule: pattern is empty after sanitization');
  }
  return Object.freeze({
    id: ruleId(host, cause, safePattern),
    host,
    cause,
    remedy: getPromptCause(cause).remedy,
    pattern: safePattern,
    grade,
    reason: reason === null || reason === undefined ? null : sanitizeValue(reason),
    evidence: evidence && typeof evidence === 'object' ? makeEvidence(evidence) : makeEvidence({}),
  });
}

// Build a rule from a RAW observed command in the safe order: grade the raw
// command (so flags / danger signals in the args are seen) THEN generalize to
// a pattern (so the stored rule carries no verbatim argument). This is the
// correct-by-construction entry point for the usage-learner so a caller can
// never accidentally grade the already-generalized `rm *` instead of the raw
// `rm -rf x` (Plan-verify peer gap #4). The grade's reason is carried onto the
// rule. host/cause/evidence are supplied by the caller.
export function makeCommandRuleFromObservation(rawCommand, { host, cause, evidence = null } = {}) {
  const { grade, reason } = gradeCommand(rawCommand);
  const pattern = generalizeCommand(rawCommand);
  return makeRule({ host, cause, pattern, grade, reason, evidence });
}

export function isValidRule(rule) {
  return (
    Boolean(rule) &&
    typeof rule === 'object' &&
    isAdvisorHost(rule.host) &&
    isPromptCause(rule.cause) &&
    getPromptCause(rule.cause).host === rule.host &&
    isSafetyGrade(rule.grade) &&
    typeof rule.pattern === 'string' &&
    rule.pattern.length > 0
  );
}

// ---------------------------------------------------------------------------
// 4. Host-config fragment CONTRACT (host-neutral envelope; rendering elsewhere)
// ---------------------------------------------------------------------------

// The concrete on-disk shape each host's settings plan renders into. The
// fragment contract is host-neutral; the actual settings.json / config.toml
// TEXT is produced by the settings-claude / settings-codex slices, never here.
export const FRAGMENT_FORMAT = Object.freeze({
  claude: 'claude-settings-json',
  codex: 'codex-config-toml',
});

// The host-level mode settings each fragment may recommend. A closed per-host
// whitelist so a Claude fragment cannot carry a Codex setting name and vice
// versa (Plan-verify peer gap #12).
export const KNOWN_MODE_SETTINGS = Object.freeze({
  claude: Object.freeze(['defaultMode']),
  codex: Object.freeze(['sandbox_mode', 'approval_policy']),
});

// A host-level mode recommendation (Claude defaultMode, Codex
// sandbox_mode / approval_policy). { setting, value, reason }. Sanitizes
// BEFORE the non-empty check so a whitespace-only field cannot pass validation
// and then collapse to empty (Plan-verify peer gap #12).
export function makeModeRecommendation({ setting, value, reason = null }) {
  const safeSetting = typeof setting === 'string' ? sanitizeValue(setting) : null;
  const safeValue = value === null || value === undefined ? null : sanitizeValue(value);
  if (!safeSetting) {
    throw new Error('makeModeRecommendation: setting is required');
  }
  if (!safeValue) {
    throw new Error('makeModeRecommendation: value is required');
  }
  return Object.freeze({
    setting: safeSetting,
    value: safeValue,
    reason: reason === null || reason === undefined ? null : sanitizeValue(reason),
  });
}

// Build a validated, frozen host-config fragment contract: the graded rules
// for one host, an optional host-level mode recommendation, and pointer-only
// notes. Asserts the no-bypass-default invariant (a mode recommendation may
// never be a permission-disabling default), that the mode setting is known for
// the host, and that every rule targets the fragment's host (so settings-codex
// can never accidentally render a Claude rule, and vice versa). Each rule is
// deep-frozen so a fragment cannot be mutated through a plain-object rule after
// construction (Plan-verify peer gap #11).
export function makeFragmentContract({ host, rules = [], modeRecommendation = null, notes = [] }) {
  if (!isAdvisorHost(host)) {
    throw new Error(`makeFragmentContract: unknown host '${host}'`);
  }
  const ruleList = Array.isArray(rules) ? rules : [];
  const frozenRules = ruleList.map((rule) => {
    if (!isValidRule(rule)) {
      throw new Error('makeFragmentContract: rules[] contains an invalid rule');
    }
    if (rule.host !== host) {
      throw new Error(`makeFragmentContract: rule for host '${rule.host}' cannot appear in a '${host}' fragment`);
    }
    return Object.isFrozen(rule) ? rule : Object.freeze({ ...rule, evidence: Object.freeze({ ...rule.evidence }) });
  });
  let mode = null;
  if (modeRecommendation) {
    mode = makeModeRecommendation(modeRecommendation);
    if (!KNOWN_MODE_SETTINGS[host].includes(mode.setting)) {
      throw new Error(`makeFragmentContract: '${mode.setting}' is not a known mode setting for ${host} (expected ${KNOWN_MODE_SETTINGS[host].join(', ')})`);
    }
    assertNoBypassDefault(host, mode.value);
  }
  const noteList = (Array.isArray(notes) ? notes : [])
    .map((note) => sanitizeValue(note))
    .filter(Boolean);
  return Object.freeze({
    schema_version: ADVISOR_SCHEMA_VERSION,
    kind: 'permission-fragment',
    host,
    format: FRAGMENT_FORMAT[host],
    rules: Object.freeze(frozenRules),
    modeRecommendation: mode,
    notes: Object.freeze(noteList),
  });
}

// Structural validator. Mirrors the constructor's guarantees (Plan-verify peer
// gap #10): rejects an unknown host, a format/host mismatch, an invalid or
// foreign-host rule, an unknown-for-host mode setting, and a forbidden bypass
// default in the mode recommendation.
export function isValidFragmentContract(fragment) {
  if (!fragment || typeof fragment !== 'object') return false;
  if (!isAdvisorHost(fragment.host)) return false;
  if (fragment.format !== FRAGMENT_FORMAT[fragment.host]) return false;
  if (!Array.isArray(fragment.rules)) return false;
  if (!fragment.rules.every((rule) => isValidRule(rule) && rule.host === fragment.host)) return false;
  const mode = fragment.modeRecommendation;
  if (mode) {
    if (!KNOWN_MODE_SETTINGS[fragment.host].includes(mode.setting)) return false;
    if ((FORBIDDEN_DEFAULT_MODES[fragment.host] || []).includes(mode.value)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 5. Boundary invariants (ADR-0038 §3/§6, ADR-0035 §4)
// ---------------------------------------------------------------------------

// The advisor never writes host config, never ships a permission-relaxing
// hook, and never recommends a permission-disabling default. Downstream slices
// import these constants so the boundary is asserted from one place rather
// than restated per file. They are facts about this capability, not toggles.
export const ADVISOR_INVARIANTS = Object.freeze({
  writesHostConfig: false,
  shipsGuardHook: false,
  recommendsBypassByDefault: false,
});

// The "switch off all safety" values that must NEVER appear as a recommended
// default. They survive only as an explicitly-labeled isolated-environment
// note in a settings slice (ADR-0038 §1), never as a fragment's
// modeRecommendation value.
export const FORBIDDEN_DEFAULT_MODES = Object.freeze({
  claude: Object.freeze(['bypassPermissions']),
  // 'never' (approval_policy) removes the approval safety surface entirely — like
  // danger-full-access it may only appear as an isolated-environment note, never a
  // recommended fragment default (ADR-0038 §1; Plan-verify peer MINOR).
  codex: Object.freeze(['danger-full-access', 'never']),
});

export function assertNoBypassDefault(host, modeValue) {
  const forbidden = FORBIDDEN_DEFAULT_MODES[host] || [];
  if (forbidden.includes(modeValue)) {
    throw new Error(
      `advisor invariant: '${modeValue}' must never be a recommended default for ${host} ` +
        '(ADR-0038 §1 — isolated-environment note only, never a fragment default)',
    );
  }
}
