// Usage-record learner — the ADR-0038 §2 "C engine".
//
// Reads available usage records (Claude transcripts + Codex rollouts), extracts
// the commands/tools that triggered (or are candidates to trigger) permission
// prompts, generalizes them to patterns, classifies each by advisor-core
// prompt-cause, and counts "seen N times" so the advisor's recommendations are
// grounded in evidence rather than guessed. When no usage record is available
// it returns an explicit no_records_available status so the advisor falls back
// to the conservative known-safe baseline (ADR-0038 §2).
//
// Format truth — where records live, the two line schemas, the four-status
// taxonomy, and the cause mapping — is documented in
// plugins/runtime/docs/usage-records-source-map.md and exercised by the fixtures
// under tests/runtime/fixtures/usage-records/. This module is the reader those
// fixtures were built for.
//
// Boundary (ADR-0038 §3/§5, ADR-0035 §4): it READS usage records and emits
// generalized patterns + counts. It writes no host config, ships no
// permission-relaxing hook, and never retains a verbatim argument string — the
// stored pattern is generalizeCommand output and every retained value is
// sanitized. Secret redaction + command generalization are delegated to the
// sanitize util; grading + rule construction to advisor-core. This module only
// parses, classifies, and counts.

import { readFileSync, statSync } from 'node:fs';
import {
  PROMPT_CAUSES,
  getPromptCause,
  isPromptCause,
  gradeCommand,
  worstGrade,
  makeRule,
  makeEvidence,
} from './permission-advisor-core.mjs';
import { generalizeCommand, sanitizeValue } from './permission-sanitize.mjs';

// ---------------------------------------------------------------------------
// Status taxonomy (source-map § Status taxonomy)
// ---------------------------------------------------------------------------

export const RECORD_STATUSES = Object.freeze([
  'readable',
  'missing',
  'permission-denied',
  'malformed',
]);

// Claude tool names that are NOT file/web/mcp and ARE prompt-causing Bash.
const CLAUDE_FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Codex sandbox-denial markers (source-map § Deriving the cause). Codex-specific
// — a generic OS "Permission denied" or a nonzero exit is deliberately NOT
// enough (the codex-cli 0.142.3 peer correction).
const CODEX_SANDBOX_MARKER = /command denied by sandbox:|sandbox denied exec error/i;

// Shell wrappers whose `-lc`/`-c` payload is the real command.
const SHELL_WRAPPERS = /^(?:bash|sh|zsh|dash|ksh)$/;

// ---------------------------------------------------------------------------
// Source classification (the only fs-touching surface)
// ---------------------------------------------------------------------------

// Classify a source path and, when readable, return its text. Never throws on
// the expected filesystem states — a missing path and an unreadable path are
// data, not errors (ADR-0038 §2 conservative degrade).
export function readRecordSource(path) {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { status: 'missing', text: null };
    }
    if (err && err.code === 'EACCES') {
      return { status: 'permission-denied', text: null };
    }
    return { status: 'missing', text: null };
  }
  if (st.isDirectory()) return { status: 'missing', text: null };
  try {
    return { status: 'readable', text: readFileSync(path, 'utf8') };
  } catch (err) {
    if (err && err.code === 'EACCES') return { status: 'permission-denied', text: null };
    return { status: 'missing', text: null };
  }
}

// ---------------------------------------------------------------------------
// Pure line parsing — one observation per prompt-causing tool invocation
// ---------------------------------------------------------------------------
//
// An observation is { host, cause, mechanism, rawCommand?, key?, rejected }.
//   - rawCommand: present for shell mechanisms (graded + generalized later).
//   - key:        present for non-shell allow-rule causes (webfetch domain,
//                 mcp tool) — the rule pattern is the key itself.
//   - cause:      a PROMPT_CAUSES id, or null for a Codex shell call that ran
//                 clean in-sandbox (baseline-informing, not a prompt event).
//   - rejected:   the user rejected the prompt (Claude) / approval was requested
//                 (Codex) — the strongest "this prompted" signal.

function splitLines(text) {
  return String(text ?? '').split('\n');
}

function basenameToken(s) {
  const t = String(s).replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}

// Normalize a Codex shell argv array to the real command string. Handles the
// `bash -lc <payload>` wrapper (the payload is the real command), an `env
// [VAR=val] <prog>` wrapper, and basenamed shell paths (`/bin/bash`). Returns
// null for a malformed wrapper with no payload (e.g. ["bash","-lc"]) so it is
// not stored as a fake `bash *` pattern (Plan-verify MINOR #5).
function normalizeCodexCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  let a = argv.map(String);
  // Unwrap `env [VAR=val ...] <prog> ...`.
  if (basenameToken(a[0]) === 'env') {
    a = a.slice(1);
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a = a.slice(1);
    if (a.length === 0) return null;
  }
  // Shell wrapper with a `-…c` flag: the next token is the real command.
  if (a.length >= 2 && SHELL_WRAPPERS.test(basenameToken(a[0])) && /^-/.test(a[1]) && a[1].endsWith('c')) {
    return a.length >= 3 && a[2] ? String(a[2]) : null;
  }
  return a.join(' ');
}

// A Codex function_call_output.output is a string OR an array of typed items
// ({type:input_text,text}|input_image|encrypted_content) (source-map § two shell
// shapes). Flatten to text so the sandbox marker can be matched regardless of
// shape; non-text items contribute nothing.
function normalizeCodexOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((it) => (it && typeof it === 'object' && typeof it.text === 'string' ? it.text : ''))
      .join('\n');
  }
  return '';
}

// Parse a Claude transcript. Returns { observations, malformedLines, status }.
// status is 'malformed' when ANY non-empty line failed to parse, else 'readable'.
export function parseClaudeTranscript(text) {
  const observations = [];
  const byToolId = new Map(); // tool_use id -> observation (for reject pairing)
  let malformedLines = 0;

  for (const line of splitLines(text)) {
    if (line.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const c of obj.message.content) {
        if (!c || c.type !== 'tool_use') continue;
        const name = c.name || '';
        let obs = null;
        if (name === 'Bash') {
          const raw = c.input?.command;
          if (typeof raw === 'string' && raw.trim()) {
            obs = { host: 'claude', cause: 'claude.bash-not-allowlisted', mechanism: 'bash', rawCommand: raw, rejected: false };
          }
        } else if (CLAUDE_FILE_WRITE_TOOLS.has(name)) {
          obs = { host: 'claude', cause: 'claude.file-modification', mechanism: 'file-write', tool: name, rejected: false };
        } else if (name === 'WebFetch') {
          const domain = webfetchDomain(c.input?.url);
          if (domain) obs = { host: 'claude', cause: 'claude.webfetch-domain', mechanism: 'webfetch', key: domain, rejected: false };
        } else if (name.startsWith('mcp__')) {
          obs = { host: 'claude', cause: 'claude.mcp-not-allowed', mechanism: 'mcp', key: name, rejected: false };
        }
        if (obs) {
          observations.push(obs);
          if (c.id) byToolId.set(c.id, obs);
        }
      }
    } else if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
      const interrupted = obj.toolUseResult?.interrupted === true;
      for (const c of obj.message.content) {
        if (!c || c.type !== 'tool_result') continue;
        if (c.is_error === true || interrupted) {
          const obs = byToolId.get(c.tool_use_id);
          if (obs) obs.rejected = true;
        }
      }
    }
  }
  return {
    observations,
    malformedLines,
    status: malformedLines > 0 ? 'malformed' : 'readable',
  };
}

function webfetchDomain(url) {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

// Parse a Codex rollout. Returns { observations, malformedLines, status }.
// A valid line whose embedded shell `arguments` is non-JSON counts as a
// malformed observation (skipped) but does NOT poison the whole line.
export function parseCodexRollout(text) {
  const calls = new Map(); // call_id -> { rawCommand }
  const causeByCall = new Map(); // call_id -> cause id
  const eventCommand = new Map(); // call_id -> rawCommand from an event
  const cleanEnd = new Set(); // call_ids with a clean exec_command_end (exit 0, no marker)
  const patchObservations = []; // apply_patch approvals — no shell command, synthetic key
  let hasExecEvents = false; // any exec/approval event seen (distinguishes legacy no-event rollouts)
  let malformedLines = 0;
  let malformedArguments = 0;

  for (const line of splitLines(text)) {
    if (line.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    const payload = obj?.payload;
    if (!payload || typeof payload !== 'object') continue;

    if (obj.type === 'response_item') {
      if (payload.type === 'local_shell_call') {
        const raw = normalizeCodexCommand(payload.action?.command);
        if (raw && payload.call_id) calls.set(payload.call_id, { rawCommand: raw });
      } else if (payload.type === 'function_call' && payload.name === 'shell') {
        let args;
        try {
          args = JSON.parse(payload.arguments);
        } catch {
          malformedArguments++;
          continue;
        }
        const raw = normalizeCodexCommand(args?.command);
        if (raw && payload.call_id) calls.set(payload.call_id, { rawCommand: raw });
      } else if (payload.type === 'function_call_output') {
        // The sandbox-denial marker can live in the call's output (not only in
        // an exec_command_end event) — function_call-shaped sessions carry it
        // here. approval (a distinct event) still wins if it also fired.
        if (payload.call_id && !causeByCall.has(payload.call_id) &&
            CODEX_SANDBOX_MARKER.test(normalizeCodexOutput(payload.output))) {
          causeByCall.set(payload.call_id, 'codex.sandbox-blocked');
        }
      }
      // Codex MCP calls are intentionally NOT tracked as a cause: Codex governs
      // MCP via approval_policy, not a per-tool allowlist, so there is no
      // host-neutral codex MCP prompt cause (source-map § Deriving the cause).
    } else if (obj.type === 'event_msg') {
      if (/^(?:exec_command_|exec_approval_request|apply_patch_approval_request|patch_apply_)/.test(payload.type || '')) {
        hasExecEvents = true;
      }
      if (payload.type === 'exec_approval_request') {
        if (payload.call_id) {
          causeByCall.set(payload.call_id, 'codex.approval-requested');
          const raw = normalizeCodexCommand(payload.command);
          if (raw) eventCommand.set(payload.call_id, raw);
        }
      } else if (payload.type === 'apply_patch_approval_request') {
        // A patch approval has no shell command — record a synthetic, non-verbatim
        // observation so it is still counted toward the approval-policy posture
        // (Plan-verify MAJOR #3). Never retain patch text.
        patchObservations.push({
          host: 'codex',
          cause: 'codex.approval-requested',
          mechanism: 'patch',
          key: 'apply_patch',
          rejected: true,
        });
      } else if (payload.type === 'exec_command_end') {
        const out = `${payload.aggregated_output ?? ''}\n${payload.formatted_output ?? ''}`;
        if (CODEX_SANDBOX_MARKER.test(out) && payload.call_id) {
          // approval wins over sandbox if both somehow fired for one call.
          if (!causeByCall.has(payload.call_id)) causeByCall.set(payload.call_id, 'codex.sandbox-blocked');
          const raw = normalizeCodexCommand(payload.command);
          if (raw) eventCommand.set(payload.call_id, raw);
        } else if (payload.call_id && Number(payload.exit_code) === 0) {
          cleanEnd.add(payload.call_id); // clean in-sandbox completion
        }
      }
    }
  }

  const observations = [];
  const ids = new Set([...calls.keys(), ...causeByCall.keys()]);
  for (const id of ids) {
    const raw = calls.get(id)?.rawCommand ?? eventCommand.get(id) ?? null;
    if (!raw) continue;
    const cause = causeByCall.get(id) ?? null;
    // A shell call with no prompt cause is "clean in-sandbox baseline" ONLY when a
    // clean exec_command_end was observed for it, OR the rollout recorded no
    // exec/approval events at all (a legacy no-event rollout — best effort). A
    // call with events present but no clean end is in-flight / aborted /
    // truncated — indeterminate, so skip it rather than count it as safe baseline
    // (Plan-verify MAJOR #4).
    if (cause === null && hasExecEvents && !cleanEnd.has(id)) continue;
    observations.push({
      host: 'codex',
      cause,
      mechanism: 'shell',
      rawCommand: raw,
      rejected: cause === 'codex.approval-requested',
    });
  }
  observations.push(...patchObservations);

  return {
    observations,
    malformedLines,
    malformedArguments,
    status: malformedLines > 0 || malformedArguments > 0 ? 'malformed' : 'readable',
  };
}

const PARSERS = Object.freeze({
  claude: parseClaudeTranscript,
  codex: parseCodexRollout,
});

// ---------------------------------------------------------------------------
// Aggregation — observations -> evidence-grounded rules ("seen N times")
// ---------------------------------------------------------------------------

// A non-shell allow-rule cause (webfetch domain, mcp tool) has no command to
// grade, so it defaults to the conservative `ask` — the advisor recommends a
// broad allow only for positively-safe shell families (advisor-core philosophy).
const NON_SHELL_DEFAULT_GRADE = 'ask';

// Cause remedies that are host-level postures (counted), not per-pattern allow
// rules. A cause with one of these contributes to modeEvidence.
const MODE_REMEDIES = new Set(['default-mode', 'sandbox-mode', 'approval-policy']);

// Group observations into advisor-core rules, each carrying usage evidence
// ("seen N times"). Returns { rules, modeEvidence, baselineCount }.
//   - rules: deduped by advisor-core rule id (host|cause|pattern); grade is the
//            WORST grade across members (conservative) for shell causes.
//   - modeEvidence: file-modification etc. — counts that justify a default-mode
//            recommendation, not an allow-rule.
//   - baselineCount: Codex shell calls that ran clean in-sandbox (cause=null) —
//            known-safe informers, not prompt events.
export function aggregateObservations(observations) {
  const groups = new Map(); // rule id -> { host, cause, pattern, grade, count, rejected, sampleRaw }
  const modeCounts = new Map(); // `${host}|${cause}` -> count
  let baselineCount = 0;

  for (const obs of observations || []) {
    if (!obs) continue;
    // Drop an unknown non-null cause defensively; null = Codex clean-run baseline.
    if (obs.cause !== null && !isPromptCause(obs.cause)) continue;

    // Codex clean in-sandbox run — informs the safe baseline, not a prompt.
    if (obs.cause === null) {
      baselineCount++;
      continue;
    }
    const remedy = getPromptCause(obs.cause).remedy;

    // A host-level mode remedy (Claude defaultMode, Codex sandbox_mode /
    // approval_policy) contributes a posture COUNT, regardless of whether the
    // observation also carries a command. This is what justifies the mode
    // recommendation in the settings slices.
    if (MODE_REMEDIES.has(remedy)) {
      const k = `${obs.host}|${obs.cause}`;
      modeCounts.set(k, (modeCounts.get(k) || 0) + 1);
    }

    // Pattern evidence: a command rule for shell observations, a key rule for
    // webfetch/mcp. Observations with no pattern (file-write, patch) were
    // already captured as mode evidence above and produce no rule.
    let pattern;
    let grade;
    if ((obs.mechanism === 'bash' || obs.mechanism === 'shell') &&
        typeof obs.rawCommand === 'string' && obs.rawCommand.trim()) {
      pattern = generalizeCommand(obs.rawCommand);
      grade = gradeCommand(obs.rawCommand).grade;
    } else if ((obs.mechanism === 'webfetch' || obs.mechanism === 'mcp') && obs.key) {
      // webfetch domain / mcp tool — the key IS the pattern.
      pattern = sanitizeValue(obs.key);
      grade = NON_SHELL_DEFAULT_GRADE;
    } else {
      continue;
    }
    if (!pattern) continue;

    const id = `${obs.host}|${obs.cause}|${pattern}`;
    const prev = groups.get(id);
    if (prev) {
      prev.count += 1;
      prev.grade = worstGrade(prev.grade, grade);
      if (obs.rejected) prev.rejected += 1;
    } else {
      groups.set(id, {
        host: obs.host,
        cause: obs.cause,
        pattern,
        grade,
        count: 1,
        rejected: obs.rejected ? 1 : 0,
      });
    }
  }

  const rules = [];
  for (const g of groups.values()) {
    const note = g.rejected > 0 ? `seen ${g.count}x, ${g.rejected} user-rejected` : `seen ${g.count}x`;
    rules.push(
      makeRule({
        host: g.host,
        cause: g.cause,
        pattern: g.pattern,
        grade: g.grade,
        reason: note,
        evidence: makeEvidence({ count: g.count, source: 'usage', note }),
      }),
    );
  }
  // Stable, deterministic order: worst grade first, then most-seen, then id.
  const sev = { deny: 0, ask: 1, allow: 2 };
  rules.sort(
    (a, b) =>
      (sev[a.grade] - sev[b.grade]) ||
      (b.evidence.count - a.evidence.count) ||
      a.id.localeCompare(b.id),
  );

  const modeEvidence = [...modeCounts.entries()].map(([k, count]) => {
    const [host, cause] = k.split('|');
    return { host, cause, count };
  });

  return { rules, modeEvidence, baselineCount };
}

// ---------------------------------------------------------------------------
// Top-level — learn from a set of sources
// ---------------------------------------------------------------------------
//
// sources: [{ path, host }]. Returns:
// {
//   status: 'analyzed' | 'no_records_available',
//   sources: [{ path, host, status, observationCount, malformedLines }],
//   rules: [advisor-core rule with usage evidence],
//   modeEvidence: [{ host, cause, count }],
//   baselineCount: number,
//   baselineUsed: boolean,    // true when no usable observations were found
// }

export function learnFromSources(sources) {
  const sourceReports = [];
  const allObservations = [];

  for (const src of Array.isArray(sources) ? sources : []) {
    const host = src?.host;
    const parser = PARSERS[host];
    if (!parser || !src?.path) {
      sourceReports.push({ path: src?.path ?? null, host: host ?? null, status: 'missing', observationCount: 0, malformedLines: 0 });
      continue;
    }
    const { status, text } = readRecordSource(src.path);
    if (status !== 'readable') {
      sourceReports.push({ path: src.path, host, status, observationCount: 0, malformedLines: 0 });
      continue;
    }
    const parsed = parser(text);
    allObservations.push(...parsed.observations);
    sourceReports.push({
      path: src.path,
      host,
      status: parsed.status, // 'readable' or 'malformed'
      observationCount: parsed.observations.length,
      malformedLines: parsed.malformedLines + (parsed.malformedArguments || 0),
    });
  }

  const { rules, modeEvidence, baselineCount } = aggregateObservations(allObservations);
  const hasEvidence = rules.length > 0 || modeEvidence.length > 0;

  return {
    status: hasEvidence ? 'analyzed' : 'no_records_available',
    sources: sourceReports,
    rules,
    modeEvidence,
    baselineCount,
    baselineUsed: !hasEvidence,
  };
}
