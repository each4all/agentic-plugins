# Usage Records Source Map

Observed on 2026-06-29 with Claude Code transcripts on disk and Codex CLI
`0.142.3` (cross-host peer) plus an older Codex `~0.13x` rollout sample. This
file is a runtime-owned host-truth checkpoint for **where Claude and Codex
persist usage records and how permission-relevant events appear in them**, so
the ADR-0038 §2 usage-learner (the "C engine") can extract the commands/tools
that triggered prompts, generalize them to patterns, and count "seen N times".
It is not a promise that either host keeps this format.

It is the format reference that the fixtures under
[`tests/runtime/fixtures/usage-records/`](../../../tests/runtime/fixtures/usage-records/)
encode; that directory's `manifest.json` is the machine-readable oracle.

## Sources

- Local Claude Code transcripts: `~/.claude/projects/**/*.jsonl` (schema-only
  inspection — no values read into the session, ADR-0038 §5).
- Local Codex rollouts: `~/.codex/sessions/**/rollout-*.jsonl` (one current
  chat session + one older exec-bearing session).
- Cross-host Codex peer (`codex-cli 0.142.3`): authoritative confirmation of the
  current Codex rollout schema, the two shell shapes, and — critically — the
  event-based permission signals. The peer corrected three points the local
  (older) sample would have gotten wrong; see [Synthesis](#cross-host-synthesis).

## What the learner needs from a record

For each permission-causing tool invocation, the learner derives a triple and
feeds it to advisor-core:

| Field | Meaning |
|-------|---------|
| `rawCommand` (or tool identity) | The observed command/tool — graded by `gradeCommand`, then generalized by `generalizeCommand` to the stored pattern. Never store the verbatim args (ADR-0038 §5). |
| `host` | `claude` or `codex`. |
| `cause` | One of the six advisor-core `PROMPT_CAUSES`. |

Evidence is the **count** of how many times a pattern was seen
(`makeEvidence({count, source:'usage'})`). A user-rejected call is the strongest
"this prompted" signal. The correct-by-construction entry point is
`makeCommandRuleFromObservation(rawCommand, {host, cause, evidence})` (grades the
raw command first, then generalizes — advisor-core gap #4).

---

## Claude Code

### Location

```text
~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
```

`<cwd-slug>` is the absolute working directory with every `/` (and other
non-alphanumerics) replaced by `-`. One JSONL transcript per session. There is
no separate "permission log"; tool calls and their outcomes live inline in the
transcript.

### Line schema (JSONL, one object per line)

Top-level `.type` ∈ `{ user, assistant, system, attachment,
file-history-snapshot, last-prompt, mode, permission-mode, summary }`.

- **assistant** — `.message.content[]` holds the model turn. A tool call is
  `{ type:"tool_use", id, name, input }`.
  - `name` ∈ `{ Bash, Read, Edit, Write, WebFetch, Glob, Grep, Task*,
    mcp__<server>__<tool>, … }`.
  - **Bash** `input = { command, description }` — `input.command` is the raw
    command string (the thing to grade + generalize).
  - **Edit/Write** `input = { file_path, … }` — a file modification.
  - **WebFetch** `input = { url, prompt }` — the rule key is the URL host.
  - **mcp\_\_** tools carry their own `input` object.
- **user** — `.message.content[]` may hold `{ type:"tool_result",
  tool_use_id, content, is_error? }`; a sibling top-level `.toolUseResult`
  carries `{ stdout, stderr, interrupted, … }` (Bash) or `{ file, type }`
  (Read/Edit).
- **permission-mode** — `{ permissionMode, sessionId, type }`. Records the
  session posture (`default`, `acceptEdits`, `plan`, `dontAsk`,
  `bypassPermissions`). Useful context: in `bypassPermissions`/`acceptEdits` the
  same call would not have prompted.

### Deriving (rawCommand, host, cause)

| Observation | host | cause | rule key |
|-------------|------|-------|----------|
| `tool_use name=Bash` | claude | `claude.bash-not-allowlisted` | `generalizeCommand(input.command)` |
| `tool_use name=Edit\|Write` | claude | `claude.file-modification` | remedy `default-mode` (no command pattern) |
| `tool_use name=WebFetch` | claude | `claude.webfetch-domain` | URL host |
| `tool_use name=mcp__*` | claude | `claude.mcp-not-allowed` | the tool name |

**Prompt vs no-prompt.** The transcript does not stamp "a prompt was shown" on
every call. Two signals: (1) a `tool_result.is_error=true` /
`toolUseResult.interrupted=true` is an explicit **user rejection** — the call
definitely prompted; (2) otherwise the learner treats a call as prompt-causing
when its generalized pattern is **not already on the host allowlist** (doctor
reads the allowlist; this map supplies the command evidence). Count frequency
per pattern for "seen N times".

---

## Codex CLI

Confirmed against `codex-cli 0.142.3`.

### Location

```text
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
```

`$CODEX_HOME` defaults to `~/.codex`. The **rollout JSONL is authoritative** for
tool/exec/approval events. Other files are NOT authoritative for these events:

- `~/.codex/history.jsonl` `{ session_id, text, ts }` — typed-prompt history.
- `~/.codex/session_index.jsonl` `{ id, thread_name, updated_at }` — picker index.
- SQLite state files store rollout paths but not the authoritative event stream.

`codex exec --ephemeral` disables rollout persistence (this is the flag the
companion uses — companion runs leave no rollout, consistent with ADR-0038's
"the companion path does not prompt"). `history.persistence` / `history.max_bytes`
govern history retention only, not tool-call records.

### Line schema (JSONL, one object per line)

Each line is `{ type, timestamp, payload }`. `.type` ∈ `{ session_meta,
turn_context, response_item, event_msg, inter_agent_communication, compacted }`.

- **session_meta** `.payload` = `{ id, session_id, timestamp, cwd, originator,
  cli_version, model_provider, … }` (no nested `type`).
- **turn_context** `.payload` carries the **permission posture** —
  `{ turn_id, cwd, model, sandbox_policy, approval_policy, permission_profile,
  workspace_roots, … }`. This is the Codex analog of Claude's `permission-mode`.
- **response_item** `.payload.type` ∈ `{ local_shell_call, function_call,
  function_call_output, custom_tool_call, mcp_tool_call_output, message,
  reasoning }`.
- **event_msg** `.payload.type` (permission-relevant) ∈ `{ exec_command_begin,
  exec_command_output_delta, exec_command_end, exec_approval_request,
  apply_patch_approval_request, patch_apply_begin/updated/end,
  mcp_tool_call_begin/end, guardian_assessment, elicitation_request,
  request_user_input }`.

### The two shell shapes

A shell command appears in one of two `response_item` shapes — handle both:

1. **`local_shell_call`** (newer): `{ type:"local_shell_call", call_id, status,
   action:{ type:"exec", command:Array<string>, working_directory, timeout_ms,
   … } }`. `action.command` is an **argv array** — no JSON parse needed.
2. **`function_call`** (name=`shell`): `{ type:"function_call", name:"shell",
   call_id, arguments:"<json string>" }`. `arguments` is a JSON string; parse it,
   then read `.command` (also an argv array). `arguments` **can fail to parse**
   even though typed as a string — treat a parse failure as unknown args.

Results pair to calls by `call_id` via `function_call_output`
`{ call_id, output }` (where `output` is a string **or** an array of
`{ type:input_text|input_image|encrypted_content }` items — normalize both) and
via the `exec_command_end` event.

### Command normalization

`command` is argv. When `command[0]` is a shell (`bash|sh|zsh|dash|ksh`) and
`command[1]` is `-lc`/`-c`, the real command is `command[2]`; otherwise join the
argv with spaces. Apply this **before** `generalizeCommand`/`gradeCommand`.

### Deriving the cause — events are authoritative (not the escalation flag)

| Signal | cause | remedy |
|--------|-------|--------|
| `event_msg.exec_approval_request` (or `apply_patch_approval_request`) with this `call_id` | `codex.approval-requested` | `approval-policy` |
| `event_msg.exec_command_end` whose `aggregated_output` / `formatted_output` (or paired `function_call_output.output`) contains a Codex sandbox marker `Command denied by sandbox:` / `sandbox denied exec error` | `codex.sandbox-blocked` | `sandbox-mode` |
| `function_call name=mcp__*` | Codex MCP approval (host-specific; not one of the two host-neutral Codex causes) | — |

Two traps the peer flagged:

- A `response_item` carrying `sandbox_permissions:"require_escalated"` (0.142.3)
  or the legacy `with_escalated_permissions:true` only means the model
  **requested** escalation. The authoritative "a prompt was produced" signal is
  the **`exec_approval_request` event**.
- A generic OS `Permission denied` or a nonzero `exit_code` is **not** enough to
  classify `codex.sandbox-blocked` — require the Codex-specific sandbox marker.

### Legacy delta

Older rollouts (pre-0.142.3) use a `function_call` `with_escalated_permissions`
boolean instead of the `sandbox_permissions` enum
(`use_default | require_escalated | with_additional_permissions`), and may emit
only `function_call` (not `local_shell_call`). A robust learner tolerates both.

---

## Status taxonomy

The loader classifies each **source path** before parsing. All four are
exercised by the fixtures (`missing` / `permission-denied` are filesystem
states, simulated at test time — see the fixtures README).

| Status | Meaning | Learner behavior |
|--------|---------|------------------|
| `readable` | exists, readable, ≥1 parseable record | parse + extract observations |
| `missing` | path absent | zero observations; fall back to the conservative known-safe baseline (`source:'baseline'`) and label it |
| `permission-denied` | exists but unreadable (`EACCES`) | zero observations; baseline fallback; do not throw |
| `malformed` | readable but has non-JSON lines, or valid lines whose embedded `arguments` are non-JSON | skip the unparseable units, extract from the survivors, never crash |

`missing` and `permission-denied` both degrade to the **baseline** rather than
failing the advisor — the advisor must still produce a conservative plan when no
usage record is available (ADR-0038 §2).

---

## Cross-host synthesis

Per the engineer investigate ensemble protocol (AGREED / LOCAL-ONLY / PEER-ONLY
/ CONFLICT):

- **AGREED** (local + peer): rollout path scheme; `{type,timestamp,payload}`
  line shape; `function_call` shape with `arguments` as a JSON string;
  result-pairing by `call_id`; `arguments` can fail to parse; companion/exec
  sessions can lack any `function_call` record.
- **PEER-ONLY** (the peer's 0.142.3 knowledge the local older sample lacked):
  `turn_context` posture line; the `local_shell_call` shape; the
  `sandbox_permissions` enum superseding `with_escalated_permissions`; and the
  **event-based** cause signals (`exec_approval_request` for approval,
  `exec_command_end` + sandbox marker for sandbox-blocked).
- **CONFLICT → resolved toward the peer**: the local sample implied the approval
  signal was the escalation flag and the sandbox signal was any nonzero exit.
  The peer (current authoritative CLI) corrected both; this map and the fixtures
  follow the peer. The older flag is retained only as a documented legacy delta.
- **LOCAL-ONLY**: the Claude transcript schema (the peer is the Codex authority,
  not Claude) and the on-disk confirmation that companion runs leave no rollout.

The correction is the cross-host ensemble doing its job: a Claude-only reading of
an older local rollout would have shipped a learner keyed on a deprecated field
and a false sandbox signal.

## Privacy

This document and the fixtures contain **no** real transcript content, secrets,
or paths. The fixtures' secret-shaped tokens are synthetic (`EXAMPLEONLY`
markers) and exist only to exercise redaction. The learner itself must keep to
ADR-0038 §5: store generalized patterns and counts only, redact via the sanitize
util, and write evidence only to `.agentic-plugins/**` artifacts.
