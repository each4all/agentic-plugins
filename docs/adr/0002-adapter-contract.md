# ADR-0002: Adapter contract — 4 required items

## Status

Accepted

## Context

ADR-0001 establishes that agentic-plugins has per-host adapters, and that
adapters are "as thin as possible, but no thinner." Without a defined
contract, host adapter code grows ad-hoc and inconsistently. Adding a
new host (Cursor, Goose, etc.) becomes a research project each time
because there is no documented checklist.

The framework needs a minimum set of items every adapter must
implement, so that:
- Plugin authors know what to expect from each adapter
- New host adoption follows a predictable pattern
- `kit/lint/` can mechanically verify adapter conformance
- Companion bridges can rely on a stable interface

## Decision

Every host adapter MUST implement the following four items:

### 1. Manifest mapping

The adapter MUST translate the CORE asset list (skills, MCP servers,
hook intents, persona descriptions) into the host's plugin manifest
format.

- Input: CORE assets + adapter-specific config
- Output: host-native manifest file at host-expected path (e.g.,
  `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`)
- Rule: the manifest MUST be valid against the host's published schema

### 2. Event mapping

The adapter MUST map CORE lifecycle events to the host's hook event
names. Where the host lacks an equivalent event, the adapter MUST
document the gap and either:
- (a) implement an equivalent at the closest available event with explanation, OR
- (b) drop the lifecycle hook with a documented "not applicable on this host" note

- Input: CORE protocol intent (e.g., "snapshot before context compression")
- Output: host hook registration in `hooks/hooks.json` (or
  host-equivalent location) plus optional gap-documentation
- Rule: never silently swallow CORE intent. Every CORE event has an
  explicit mapping or an explicit "no equivalent" note

### 3. Companion invocation

The adapter MUST invoke peer-host companions via the standard interface
defined in `companions/contract.md`. Direct shell-out with ad-hoc
prompt construction is forbidden.

- Input: prompt structured per `companions/contract.md`
- Output: the companion's parsed structured response
- Rule: the adapter MUST NOT bypass the companion contract; specifically,
  it MUST NOT call the peer host's CLI directly with ad-hoc XML or
  string concatenation. All cross-host peer-agent invocation goes
  through the companion bridge

### 4. Path resolution

The adapter MUST provide a way for plugin scripts (hooks, MCP server
launchers, etc.) to resolve the plugin's absolute installation path on
the local filesystem.

- Input: plugin metadata + host install convention
- Output: a resolvable path or environment variable
- Rule: plugin scripts SHOULD NOT hardcode paths. The adapter provides
  the resolution mechanism (Claude: `${CLAUDE_PLUGIN_ROOT}` variable
  expansion; Codex: setup-time absolute path injection or a comparable
  mechanism). Where a host lacks a built-in plugin-root variable, the
  adapter MUST provide an equivalent mechanism documented in the
  adapter's own README

## Consequences

**Positive**:
- New host adoption has a clear checklist (4 items)
- `kit/lint/` can mechanically check that each adapter implements all 4
- Plugin authors interact with a stable abstraction regardless of host
- Adapter code is bounded — anything beyond these 4 is host-specific
  detail rather than framework concern

**Negative**:
- Hosts that don't fit cleanly may require workarounds (e.g., Codex's
  lack of plugin-root variable forces setup-time path injection)
- The contract may need extension as new framework concerns emerge
  (e.g., when statusline/monitor support is added cross-host); a
  contract change requires a new ADR

**Neutral**:
- This contract is the minimum, not the maximum. Adapters are free to
  implement additional host-specific affordances (e.g., Claude
  adapter's PreCompact handling) as long as the four required items are
  honored

## Alternatives Considered

1. **No formal contract — adapters do whatever** — Rejected. Drift
   inevitable; new host adoption becomes case-by-case research

2. **Detailed code-level contract (interface in TypeScript/Python)** —
   Considered. Premature for a framework with two adapters and no
   external contributors yet. Revisit when adding the third host or
   opening to external contributors

3. **Companion-invocation as MCP only** — Rejected. See ADR-0003. MCP
   is the wrong abstraction for peer-agent invocation; companion-CLI
   is correct

4. **Path resolution via environment variable only** — Rejected. Codex
   does not (currently) expose a plugin-root environment variable; the
   contract must accommodate hosts that resolve paths differently
