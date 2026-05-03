# companions/contract.md — Wire Spec

> Bidirectional companion bridge contract between Claude Code and OpenAI
> Codex CLI. Both companions implement this single contract; the
> contract surface is identical regardless of direction
> (Claude → Codex via `codex-companion`, Codex → Claude via
> `claude-companion`).

## Status

- **Version**: `v0.1.0`
- **Stage**: 1 (first cut, alongside the first reference plugin)
- **Stance**: wire-spec only — see § 1 Overview & Stance
- **Change procedure**: this contract changes only via ADR. See § 8
  References & Versioning

---

## 1. Overview & Stance

`companions/contract.md` defines the **observable wire surface** that
both companion scripts MUST honor:

- how a caller adapter invokes a companion script (CLI args, prompt
  input mode);
- how a prompt is structured on its way to the peer host CLI (XML
  vocabulary);
- how the peer's output is conveyed back to the caller (text or
  JSON-envelope);
- how errors are categorized (exit codes + named error kinds).

Anything that is not in those four areas is **out of scope** for this
contract — companion implementations are free in the unspecified space.
This is a deliberate design choice and is explained in § 6 Out of Scope.

### Stance

The contract is governed by four principles, each anchored in an ADR:

| Principle | One-line statement | ADR |
|---|---|---|
| **Wire-spec only** | observable wire is contract; companion-internal behavior is not | ADR-0001 final note ("honest scope" — applied here to wire-vs-implementation scoping) |
| **Bidirectional symmetry** | identical contract surface in both directions; per-direction differences live inside each companion script | ADR-0001 (COMPANION layer) |
| **1st-party via public CLIs** | both companions shell out to **public** peer-host CLIs (`claude -p`, `codex exec`); no third-party plugin or non-public host APIs | ADR-0004 |
| **Companion is the only path** | adapters MUST NOT shell out to peer-host CLIs ad-hoc; all cross-host peer-agent invocation goes through this contract | ADR-0002 — Companion invocation requirement (item 3) |

The Stage 1 redesign stance (ADR-0007) governs what this contract is
*not*: it is not a port of `omcc/codex-companion`. omcc patterns are
referenced in this document only as "do-not-port" markers (§ 6 explicitly
excludes Codex's internal app-server APIs and the omcc subcommand
sprawl).

### Reading order

If you are implementing a companion: read § 1 → § 2 → § 3 → § 4 → § 5,
then sanity-check against § 6 (what NOT to add) and § 7 (markers tooling
will look for).

If you are implementing an adapter that calls a companion: read § 1,
§ 2 (CLI to invoke), § 3 (prompt to send), § 4 (output to parse), § 5
(errors to handle).

---

## 2. Invocation Surface

A companion is a single executable script:

```
companions/claude-companion.mjs   # Codex → Claude direction
companions/codex-companion.mjs    # Claude → Codex direction
```

### 2.1 Subcommand

The contract defines exactly **one mandatory subcommand**: `task`.

```
<companion> task [options] [PROMPT_ARG]
```

`PROMPT_ARG` is a positional argument carrying the XML-structured
prompt as a single string. It is mutually exclusive with `--prompt-file`
and stdin (see § 2.3 Prompt input precedence).

Adding new subcommands is a contract change and requires an ADR
(see § 6 Out of Scope on subcommand sprawl).

### 2.2 Options

The contract pins these option names. Companion implementations MUST
recognize them and MUST NOT redefine their meaning. Companion
implementations MAY add additional options for companion-internal
concerns; those additions MUST NOT clash with names defined here.

| Option | Argument | Required | Meaning |
|---|---|---|---|
| `--prompt-file` | path | one of three input modes (see § 2.3) | path to a file containing the XML-structured prompt. Any I/O error on this path (file not found, EACCES, path is a directory, malformed UTF-8 content) MUST produce exit code `2` / `companion_misuse` |
| `--model` | string | optional | peer model identifier; semantics per peer host. If omitted, the companion picks a default consistent with the peer host's own default |
| `--effort` | string | optional | peer effort/reasoning level; values are peer-host specific. If omitted, peer-host default applies |
| `--cwd` | path | optional | working directory passed to the peer CLI. If omitted, the companion uses its own working directory |
| `--output-format` | `text` \| `json` | optional (default `text`) | companion's stdout shape — see § 4 |

#### What is not on this list

Any flag that is companion-internal — for example timeout knobs, retry
counts, sandbox modes, log verbosity — is *not* in this contract.
Companions MAY expose such flags in their own help text and README,
but those are not part of the cross-companion wire contract and may
differ between `claude-companion` and `codex-companion`.

### 2.3 Prompt input precedence

Exactly one input mode is selected per invocation. Precedence (highest
priority first):

1. `--prompt-file <path>` — read prompt from the given file (UTF-8).
2. `PROMPT_ARG` — positional argument, used when `--prompt-file` is not
   given.
3. **stdin** — used when neither `--prompt-file` nor `PROMPT_ARG` is
   given AND stdin is a pipe (not a TTY).

Conflict and missing-input rules (companion MUST exit with
`companion_misuse`, exit code `2`, in every case below):

- Both `--prompt-file` and `PROMPT_ARG` are given.
- `--prompt-file` is given AND stdin is a pipe (not a TTY).
- `PROMPT_ARG` is given AND stdin is a pipe (not a TTY).
- No flag, no positional argument, AND stdin is a TTY (no input
  source available).

A piped stdin combined with a higher-precedence flag is treated as a
**conflict**, not as silently-discarded input. This is deliberate —
silently discarding stdin would hide caller mistakes (e.g., a pipe
that was meant to be the prompt). Callers wanting to use stdin MUST
omit `--prompt-file` and `PROMPT_ARG`.

On any conflict or missing-input case, the companion emits a one-line
stderr summary describing which rule was violated, in addition to
returning exit code `2`.

### 2.4 Environment

Companions MUST NOT require any agentic-plugins-specific environment
variable to run — invocation works as soon as the peer host CLI is
installed and authenticated. Peer-host environment variables (e.g., the
peer's own auth tokens) are pass-through; companions do not consume or
filter them.

---

## 3. Prompt Structure (XML)

The prompt sent through the companion is an XML fragment. The contract
pins the **vocabulary** (element names + semantics) but does not pin a
specific root element — callers MAY wrap the elements in any container
they choose (`<prompt>`, `<request>`, etc.) or send them as a sibling
sequence.

Companions MUST forward the prompt's bytes to the peer verbatim and
MUST NOT parse the prompt as XML — fragments without a root element
are valid on the wire. Any prompt-shape validation envisioned in § 7.4
(Conformance Hooks) is text-level (substring or regex search), not
strict W3C XML parsing.

### 3.1 Mandatory elements

Every prompt SHOULD contain exactly one each of:

- `<task>` — imperative description of what the peer is asked to do.
  Free-form text content.
- `<grounding_rules>` — boundary rules the peer is asked to honor.
  Content is free-form text or a list of `<rule>` children; both
  shapes are valid.

These elements are SHOULD-level on the wire because the contract
defers shape validation to callers (companions forward verbatim per
§ 3 introduction). Companions MAY emit a stderr warning when a prompt
lacks one of these elements or includes multiple `<task>` elements,
but MUST NOT reject the prompt on that basis.

### 3.2 Optional elements

A prompt MAY also contain:

- `<inputs>` — additional context the peer needs (file excerpts, prior
  decisions, references, etc.). Children may be `<input>` elements with
  `name` attributes, or any caller-defined sub-structure.
- `<expected_output>` — expectation about the shape, length, or format
  of the peer's output. Free-form text; non-normative on the wire (the
  peer chooses how to honor it).

Element multiplicity rules:

- `<inputs>` and `<expected_output>` SHOULD appear at most once if used.
- Callers MAY include further caller-defined elements outside this
  vocabulary; companions forward them verbatim and downstream parsing
  is the caller's concern.

### 3.3 Encoding & whitespace

- Encoding: UTF-8.
- Standard XML escaping applies (`&amp;`, `&lt;`, `&gt;`, `&quot;`,
  `&apos;`).
- Whitespace inside the prompt is preserved verbatim during forwarding
  to the peer (see § 3 introduction — companions do not parse).
- The contract does NOT require XML declaration (`<?xml ... ?>`) or
  DOCTYPE; companions MUST accept prompts that omit them.

### 3.4 Example

```xml
<task>
Write a 50-word summary of the attached document.
</task>

<grounding_rules>
<rule>Stay within the document content; do not introduce facts not present.</rule>
<rule>Output exactly one paragraph, plain text.</rule>
</grounding_rules>

<inputs>
<document name="brief.md">
... document content here ...
</document>
</inputs>

<expected_output>
A single paragraph of approximately 50 words.
</expected_output>
```

This prompt is well-formed under this contract: one `<task>`, one
`<grounding_rules>`, one optional `<inputs>`, one optional
`<expected_output>`. The companion forwards it as-is to the peer.

---

## 4. Output Convention

How the companion conveys the peer's response back to the caller is
controlled by `--output-format`.

### 4.1 Text mode (default)

`--output-format text` (or omitted) → companion stdout is the peer
host CLI's raw stdout, verbatim, with no envelope or wrapper.

The caller adapter is responsible for parsing the peer's content (e.g.,
extracting markdown, splitting on a known delimiter, etc.). The
contract does not constrain that parsing — it is the caller's concern.

Stderr behavior in text mode:
- on success: empty.
- on error: one-line human-readable summary (see § 5).

Exit code: see § 5.

### 4.2 JSON envelope mode

`--output-format json` → companion stdout is exactly one JSON document
(may be a single line or pretty-printed; readers MUST tolerate both).
The document conforms to the envelope below.

```jsonc
{
  "status":      "success" | "peer_error" | "companion_error",
  "peer_host":   "claude" | "codex",
  "peer_model":  "<resolved model name string>" | null,
  "stdout":      "<peer's raw stdout, verbatim>",
  "exit_code":   <integer; 0 on success, otherwise per § 5>,
  "metadata": {                                  // optional
    "duration_ms":   <integer>,
    "started_at":    "<ISO 8601 UTC, Z suffix>",
    "completed_at":  "<ISO 8601 UTC, Z suffix>"
  },
  "error": {                                     // present iff status != "success"
    "kind":    "<one of the values in § 5.3>",
    "message": "<single-line human-readable summary>",
    "detail":  "<multi-line detail string>" | null
  }
}
```

Required envelope fields: `status`, `peer_host`, `peer_model`,
`stdout`, `exit_code`. `peer_model` is REQUIRED but its value MAY be
`null` — for example, when the companion exits before resolving a
model (`companion_misuse`) or when the peer host CLI did not report a
resolved model. When the companion did invoke the peer successfully
and a model was resolved, `peer_model` MUST carry the resolved model
name. The `metadata` object is optional, and when present, all three
sub-fields SHOULD be set together. The `error` object is present iff
`status` is not `"success"`.

Forward compatibility: callers MUST tolerate unknown top-level fields
on the envelope (treat them as informational and ignore). Companion
implementations MUST NOT remove or rename existing fields without a
contract change (ADR-driven).

Stderr behavior in JSON mode: same as text mode (one-line summary on
error, empty on success). The structured detail belongs in
`error.detail` of the envelope; stderr remains a human-readable hint.

### 4.3 Mode selection (advisory)

Text mode is the default; JSON mode is appropriate when the caller
needs companion-level metadata or a uniform structured shape for
logging and routing. This guidance is advisory — both modes are fully
part of the wire spec.

---

## 5. Error Semantics

### 5.1 Exit codes

Exit codes are pinned. Implementations MUST use exactly these values
for these meanings.

| Exit code | Meaning |
|---|---|
| `0` | Success. Peer ran and produced output. |
| `1` | **Peer run error**. The peer CLI was reachable and ran, but the peer's run reported an error (e.g., the model returned an error in its content, the peer's own exit code was non-zero, or the peer's output was unusable for a reason the companion can detect). |
| `2` | **Companion misuse**. Invalid arguments, missing required prompt input, conflicting flags, malformed UTF-8 in `--prompt-file`, etc. The companion detected a caller-side problem before invoking the peer. |
| `3` | **Peer CLI infrastructure error**. The peer CLI is not on PATH, the peer's auth is missing or expired, the peer process failed to start, or another infrastructure-level failure occurred. The specific `error.kind` (`peer_cli_not_found`, `peer_unauthenticated`, `peer_invocation_error`) is reported in JSON mode per § 5.3. |

Adding a new exit code is a contract change (ADR required).

### 5.2 Stderr convention

Regardless of mode:

- On `0`: stderr is empty.
- On non-zero exit: stderr carries one single-line human-readable
  summary, suitable for being shown to a human user verbatim. Maximum
  length is implementation-defined but SHOULD stay under ~200
  characters; companions MUST NOT split a single error across multiple
  lines on stderr.

Multi-line, multi-paragraph, or otherwise structured error detail
belongs in `error.detail` of the JSON envelope (§ 4.2). In text mode,
that detail is simply not exposed — callers wanting the detail must use
`--output-format json`.

### 5.3 Joint `status` / `exit_code` / `error.kind` table

When the JSON envelope's `error` object is present, `error.kind` MUST
be one of the values listed below. The relationship between `status`,
`exit_code`, and `error.kind` is fixed: each row jointly specifies the
required triple, and implementations MUST NOT emit combinations not
listed here.

| `status` | `exit_code` | `error.kind` | Meaning |
|---|---|---|---|
| `success` | `0` | (none — `error` object absent) | Peer ran and produced output. |
| `peer_error` | `1` | `peer_run_error` | Peer ran and returned, but the peer's own report indicates a run-time error (peer non-zero exit, model-reported error, unusable output). |
| `companion_error` | `2` | `companion_misuse` | Caller passed arguments the companion could not act on (invalid flags, missing prompt input, conflicting input modes per § 2.3, file I/O errors on `--prompt-file`, malformed UTF-8). |
| `companion_error` | `3` | `peer_cli_not_found` | Peer host CLI is not on PATH or not invokable. |
| `companion_error` | `3` | `peer_unauthenticated` | Peer host CLI ran but reported missing or expired authentication. |
| `companion_error` | `3` | `peer_invocation_error` | Peer process failed to start or terminated abnormally before producing output, for an infrastructure reason other than the two above. |

Adding a new `error.kind` value is a contract change (ADR required).
New `error.kind` values added by ADR are appended to this table with
their required `status` and `exit_code` companions; implementations
MUST emit the exact triple specified for each row.

### 5.4 What error categorization is NOT

The contract does not classify errors finer than the table above. In
particular:

- Network errors, model overload, rate limit responses, content policy
  refusals — these are all reported by the peer in its own output
  channel. The companion forwards that output verbatim (text mode) or
  packages it as `peer_run_error` (JSON mode) without attempting to
  parse the peer's content for finer categorization.
- Recovery from transient failures (retry, backoff) is companion-
  internal and out of scope (see § 6).

---

## 6. Out of Scope

These topics are explicitly *not* part of this contract. They are not
"missing"; they are deferred or structurally out of bounds.

Each entry below states the topic, what is excluded, and why.

### 6.1 Streaming / partial-message mode

**Excluded**: real-time streamed output. Both peer host CLIs support
stream-json modes, but this contract emits text or a single JSON
envelope only.

**Why**: streaming introduces timing semantics (chunk boundaries,
partial-message reassembly, midstream cancellation) that need their
own design pass, and Stage 1 callers do not yet have a partial-message
UX to validate against. Future ADR (8+) when partial-message UX
justifies it.

### 6.2 Companion-internal timeout policy

**Excluded**: timeouts on peer invocation, on stdin read, on output
buffering.

**Why**: appropriate timeouts depend on the peer host's runtime
characteristics (model latency, network) which evolve outside this
contract's control. Pinning timeouts here would tie contract evolution
to environmental variation. Companions MAY expose their own timeout
flags as companion-internal concerns.

### 6.3 Companion-internal retry policy

**Excluded**: automatic retry on transient peer errors (network, rate
limit, etc.).

**Why**: same as § 6.2 — environmental factors. Each companion
implementation chooses retry behavior; the contract reports outcomes
via § 5 error semantics regardless of retry strategy.

### 6.4 Background jobs / queues / persistent threads

**Excluded**: background execution, job tracking, persistent peer
session threads, multi-turn resume.

**Why**: this contract is stateless single-shot. A `task` invocation
is one peer turn from start to finish. Multi-turn semantics are
substantial enough to deserve their own ADR (8+) if they become
necessary. The omcc-codex-companion pattern of persistent threads
plus a job state file (background, status, result, cancel
subcommands) is explicitly *not* ported here — see § 6.8.

### 6.5 Per-task output schemas

**Excluded**: structured output schemas keyed by the kind of task being
performed (review, summary, classification, etc.).

**Why**: that level of structure is a *caller-side* concern. The
contract carries an XML prompt + a free-form text or generic JSON
envelope. Plugins and skills layered on top of the contract MAY define
their own per-task schemas (using `--expected_output` in the prompt,
or by having the calling adapter parse the peer's stdout) — those
schemas live in plugin/skill code, not in this contract.

### 6.6 Authentication mechanism

**Excluded**: how the peer host CLI authenticates, where credentials
live, how to log in.

**Why**: each peer host owns its own authentication path
(`claude login`, `codex login`, env-var-based API key, etc.). The
contract treats authentication failures as exit code `3` /
`peer_unauthenticated` and stops there. Specifying an auth flow would
mean tracking each peer host's auth evolution, which is structural
overreach.

### 6.7 Codex internal app-server APIs

**Excluded**: `runAppServerTurn`, `runAppServerReview`, and any other
non-public Codex internals.

**Why**: ADR-0004 (1st-party ownership) plus ADR-0007 (redesign
stance) explicitly forbid depending on non-public peer-host APIs. The
omcc-codex-companion uses these APIs; agentic-plugins companions MUST
NOT. Both companions in this repository use only public CLI surfaces
(`claude -p`, `codex exec`).

### 6.8 Subcommand sprawl

**Excluded**: subcommands beyond `task`. (Reference: omcc-codex-
companion, the experiential input we are *not* porting, exposes
multiple additional subcommands. This contract surface defines only
`task`.)

**Why**: each subcommand encodes a workflow that is genuinely
adjacent to peer-agent invocation but distinct from it (job
management, review-flavored prompting, setup checks). Stage 1's value
is in nailing the single peer-agent invocation case. If Stage 2/3
reveals a real need for additional subcommands, they are added via
ADR — that ADR also bumps the contract version per § 8.

---

## 7. Conformance Hooks

This section is **informative**, not normative — it describes markers
that future tooling (`kit/lint/`) MAY check mechanically. It does not
add new requirements; conformance checks fail on requirements stated
in § 2 through § 5, not on items here.

### 7.1 CLI surface markers

A conformant companion script:

- Defines exactly the subcommand `task` (§ 2.1).
- Recognizes the option names `--prompt-file`, `--model`, `--effort`,
  `--cwd`, `--output-format` with the meanings pinned in § 2.2.
- Implements the prompt input precedence rule of § 2.3, exiting with
  exit code `2` on conflict or absence of input.
- Maps `--output-format` values `text` and `json` to the shapes in § 4.

### 7.2 Output envelope markers (JSON mode)

When invoked with `--output-format json`, the companion's stdout
parses as a single JSON document containing at minimum the keys
`status`, `peer_host`, `peer_model`, `stdout`, and `exit_code` (§ 4.2).
Additional keys are tolerated. `error.kind`, when present, is one of
the enumerated values in § 5.3.

### 7.3 Error markers

Exit codes appearing in conformance test runs are within the set
`{0, 1, 2, 3}` (§ 5.1). Stderr on a non-zero exit conforms to the
single-line rule in § 5.2.

### 7.4 Prompt vocabulary markers (advisory)

The contract does NOT require companions to validate prompt structure
(the caller is responsible). However, future tooling MAY emit advisory
warnings when:

- a prompt sent through a companion lacks `<task>` or
  `<grounding_rules>`;
- a prompt contains multiple `<task>` elements.

Such warnings are stderr-only and do not affect exit code (§ 3.1
states the companion MAY warn but MUST NOT reject).

---

## 8. References & Versioning

### 8.1 In-repo references

Architecture & decisions:

- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — three-layer
  Hexagonal model; companion layer overview.
- [`docs/adr/0001-hexagonal-architecture.md`](../docs/adr/0001-hexagonal-architecture.md)
  — CORE / ADAPTER / COMPANION boundaries; "honest scope" rule.
- [`docs/adr/0002-adapter-contract.md`](../docs/adr/0002-adapter-contract.md)
  — item 3 (Companion invocation): adapters MUST invoke companions
  through this contract.
- [`docs/adr/0003-mcp-vs-companion.md`](../docs/adr/0003-mcp-vs-companion.md)
  — peer-agent invocation belongs to companion-CLI, not MCP.
- [`docs/adr/0004-companion-ownership.md`](../docs/adr/0004-companion-ownership.md)
  — both companions are first-party; no third-party plugin
  dependency.
- [`docs/adr/0007-migration-cutover-plan.md`](../docs/adr/0007-migration-cutover-plan.md)
  — redesign stance: omcc patterns are experiential input only, not a
  port target.

Implementation files (forthcoming, in this same directory):

- `companions/claude-companion.mjs` — Codex → Claude direction.
- `companions/codex-companion.mjs` — Claude → Codex direction.
- `companions/tests/` — round-trip smoke tests against real peer-host
  CLIs.

### 8.2 External references

Peer host CLIs evolve outside this repository. The contract pins the
*shape* of how companions invoke them, not the exact peer-host flag
spellings. Authoritative references for the peer-host CLI surfaces:

- Claude Code CLI: `claude --help` (output of the locally-installed
  `claude` command). Vendor: Anthropic.
- Codex CLI: `codex exec --help` (output of the locally-installed
  `codex` command). Vendor: OpenAI.

When a peer host changes a flag (e.g., renames `--print` or adjusts
`--output-format`), the affected companion's *internal* mapping is
updated; the contract surface defined in § 2–§ 5 stays unchanged.
That is the encapsulation guarantee.

### 8.3 Versioning

- **Current version**: `v0.1.0` — Stage 1 baseline (see Status block
  at the top of this document).
- **Compatibility policy**: any change that adds an optional element,
  optional flag, optional envelope field, or new `error.kind` value
  *without* removing or renaming existing items is a **minor** bump
  (e.g., `v0.1.0` → `v0.2.0`). Removing or renaming any pinned name,
  changing semantics of an existing field, or changing exit-code /
  `error.kind` mappings is a **major** bump.
- Pre-1.0 SemVer applies: while below 1.0, anything MAY change at any
  version bump per SemVer 2.0.0; agentic-plugins additionally requires
  every breaking change be ADR-driven (next item).
- **Change procedure**: every change to the contract goes through an
  ADR per [`AGENTS.md`](../AGENTS.md) § ADR process. The ADR proposing
  the change MUST cite this document, name the new version number,
  and update the Status block at the top of this document on merge.
- **Compatibility window**: the project does not commit to long-term
  pre-1.0 backward compatibility. After 1.0, removed or renamed names
  are deprecated for at least one minor release before removal,
  documented in the ADR that introduces the change.
