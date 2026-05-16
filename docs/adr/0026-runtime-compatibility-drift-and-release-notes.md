# ADR-0026: Runtime compatibility drift and release-note evidence

## Status

Accepted

## Context

The runtime/operator track in ADR-0024 made host readiness a first-class
framework concern. That readiness depends on moving host surfaces:
Claude Code, Codex CLI, plugin management, hooks, subagents, model and
effort flags, sandboxing, approvals, and companion execution behavior can
change outside this repository.

A stale baseline is dangerous in both directions. If agentic-plugins
assumes compatibility after a host upgrade, it can overstate cutover
readiness. If it treats every version change as an implementation blocker,
it can stall on noise. The project needs a small, repeatable compatibility
evidence loop that records observed host versions, compares them to the
accepted baseline, and requires release-note evidence only when it is
actually needed.

The loop must also respect the runtime safety boundary. Release-note URLs
can point to arbitrary network resources, and host compatibility evidence
can include raw help text or release-note bodies. Those materials are useful
artifacts, but they should not be fetched implicitly or pasted into the main
session.

## Decision

### 1. `runtime:compat` owns host compatibility evidence

`plugins/runtime` owns a `runtime:compat` surface for compatibility
snapshots, gap analysis, release-note ingestion, and update planning.

It is an artifact-producing operator command, not a host mutation command.
It must not install or update host CLIs, authenticate users, mutate Claude
or Codex config, update plugins, relax sandbox/approval/permission settings,
or declare final host parity.

### 2. Snapshots record observations, not conclusions

`runtime:compat snapshot` records:

- `claude --version` and `codex --version` observations;
- selected help/plugin-help byte counts and hashes, not raw help text in
  main output;
- the remembered runtime host-parity baseline versions;
- release-please plugin versions from the current checkout;
- a pointer to the generated `.agentic-plugins/runs/compat/<run-id>/`
  artifact directory.

The snapshot is evidence input. It does not by itself mean compatibility is
current.

### 3. Changed host versions require content-backed release notes

`runtime:compat check` compares the snapshot against the accepted
host-parity baseline.

If an observed host version changed, the gap remains
`release_notes_required` until either:

- a content-backed release-note artifact mentions both the changed host and
  the observed version; or
- the accepted baseline is intentionally refreshed in repository docs after
  human review.

A release note for the wrong host or wrong version may be stored, but it
does not clear the changed-version gap.

### 4. Release-note collection is explicit

`runtime:compat ingest-release-notes` accepts two source shapes:

- `--release-notes-file <path>` stores content immediately.
- `--release-notes-url <url>` stores a URL pointer by default.

URL content is fetched only when the operator also supplies
`--fetch-release-notes-url`. Fetched URL bodies and file contents are stored
as artifacts and referenced by pointer, byte count, and hash. Raw
release-note bodies are not printed into the main session, doctor output, or
cutover summaries.

### 5. Planning is advisory and surface-oriented

`runtime:compat plan` emits an advisory compatibility update plan from the
gap analysis and release-note content. It may classify affected surfaces such
as hooks, companion execution, skills, subagents, plugin management,
model/effort, sandbox/permissions, auth, MCP, and config.

The plan recommends an implementation sequence, but it does not mutate
source files or host state. Non-trivial compatibility implementation should
start as ordinary engineer/orchestrator development work.

### 6. Artifacts include the governing policy

Compatibility snapshots, gap analyses, release-note indexes, and plans carry
a small policy block that points back to this ADR. The block records the ADR,
evidence model, URL-fetch boundary, changed-version rule, and mutation
boundary so downstream tools can explain which compatibility policy governed
an artifact.

### 7. Runtime consumers read metadata only

`runtime:doctor` and `runtime:cutover` may consume the latest compat
metadata to report whether host-version drift is current, stale, blocked, or
waiting on release-note evidence. They must not read raw help bodies or raw
release-note bodies into the main output.

## Consequences

Positive:

- Host-version drift becomes a repeatable artifact trail instead of memory or
  ad hoc notes.
- Release-note evidence is required only when observed versions actually
  diverge from the accepted baseline.
- URL fetching is deliberate and auditable.
- Doctor and cutover can block on missing compatibility evidence without
  owning compatibility planning themselves.

Negative:

- Compatibility planning still depends on human-quality release-note
  interpretation; keyword classification is only an advisory first pass.
- A baseline refresh remains a repository review action, not a runtime
  command.
- URL pointers without fetched or file-backed content cannot clear a drift
  gap.

Neutral:

- This ADR does not define host-update automation.
- This ADR does not define a permanent taxonomy for every host feature. The
  surface labels are intentionally pragmatic and may grow with observed host
  changes.

## Alternatives Considered

### Fold compatibility checks into `runtime:doctor`

Rejected. Doctor should summarize host readiness and artifact health, but
compatibility drift needs durable snapshots, release-note artifacts, and
plans. Keeping that loop in `runtime:compat` avoids turning doctor into a
mutation or artifact authoring surface.

### Automatically fetch release-note URLs

Rejected. Automatic network fetch would blur operator intent and could pull
large or irrelevant content into local artifacts. URL content fetch remains
explicit through `--fetch-release-notes-url`.

### Treat any version mismatch as a hard implementation blocker

Rejected. A host version can change without affecting the compatibility
surfaces agentic-plugins uses. The right blocker is missing or mismatched
evidence, not the version mismatch alone.

### Accept URL pointers as release-note evidence

Rejected. A pointer is useful provenance, but it is not content-backed
evidence. Changed host/version coverage requires stored file content or an
explicitly fetched URL body.
