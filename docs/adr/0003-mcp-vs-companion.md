# ADR-0003: MCP vs companion-CLI — when to use which

## Status

Accepted

## Context

agentic-plugins has two mechanisms for exposing capability across hosts:

1. **MCP server** — registered in each host's MCP config, exposes
   tool-shaped capabilities via the open Model Context Protocol
2. **Companion CLI** — first-party bridge scripts (claude-companion,
   codex-companion) shelled out from the calling host, used for
   invoking the peer host as a peer agent

Both mechanisms can technically be used for many purposes, but they
have different shapes and trade-offs. Without a clear principle for
when to use which, the framework grows inconsistent and the same
capability gets exposed two different ways in different places.

omcc currently uses the companion-CLI pattern (codex-companion via
shell-out from omcc-dev) for peer-agent invocation. The reason was
sound but undocumented: peer-agent invocation is fundamentally
different from atomic tool calls.

## Decision

The two mechanisms have distinct, non-overlapping roles:

### MCP server — for stateless atomic tool calls

Use MCP when the capability is:
- A single request-response interaction
- Stateless (no multi-turn reasoning required)
- Returns structured data (JSON, text, image)
- Examples: a database lookup, a single file read, a single API call,
  a single transformation, a single search query

MCP servers are registered identically in both hosts (Claude `.mcp.json`
or settings; Codex `[mcp_servers.<name>]` in config.toml). The same
server binary works in both — this is the strongest portability benefit
of MCP.

### Companion-CLI — for peer-agent invocation

Use the companion-CLI bridge when the capability is:
- An open-ended turn requiring the peer agent to use its own tools
- Multi-step reasoning that benefits from the peer agent's full context
  and capability
- An "ensemble round" — the peer agent independently produces an answer
  that gets merged with the calling agent's answer
- Examples: dual-model research-scan (omcc-research's pattern),
  dual-model brainstorm, code review by a peer agent, full-turn
  delegation ("rescue")

Companion calls go through `companions/contract.md`:
- XML-structured prompt with `<task>`, `<grounding_rules>`, etc.
- Output parsed per the contract's schema
- Adapters do NOT shell out to peer host CLIs directly with ad-hoc prompts

## Consequences

**Positive**:
- Clear principle eliminates ambiguity in framework design
- MCP usage stays focused on its strength (atomic, stateless, portable)
- Companion-CLI usage stays focused on its strength (peer-agent
  invocation with full host capability)
- Symmetric: both directions (Claude→Codex, Codex→Claude) use the same
  pattern

**Negative**:
- Plugin authors must distinguish "is this an atomic tool call or a
  peer-agent turn?" — usually obvious but occasionally subtle
- Companion-CLI invocation has shell-out overhead (process startup,
  CLI argument parsing, output parsing). For high-frequency atomic
  operations, MCP wins. For occasional open-ended turns, companion
  wins.

**Neutral**:
- This decision says nothing about WHICH MCP servers or WHICH
  companion contract — those are separate concerns

## Alternatives Considered

1. **MCP for everything** — Rejected. MCP's request/response model
   doesn't fit peer-agent invocation. An MCP tool that "runs an AI
   agent turn" works mechanically but loses the peer-agent semantics
   (independent tool use, multi-step reasoning, fresh context). The
   calling host can't easily inject grounding rules or constrain output
   format the way an XML-structured companion prompt can

2. **Companion for everything** — Rejected. Process startup overhead
   makes it unsuitable for high-frequency atomic operations. Also,
   atomic capabilities are exactly what MCP was designed for; using
   companion-CLI for them is reinventing the wheel

3. **Use whichever feels right per case** — Rejected. Without a
   principle, the framework grows inconsistent and plugin authors lack
   guidance

4. **Define companion-CLI as a special MCP transport** — Considered.
   Could be elegant in theory. Rejected because (a) MCP transport
   abstraction is for the protocol layer, not the semantic layer, and
   (b) peer-agent invocation has too many concerns (XML grounding,
   structured output parsing, cross-host auth) that don't fit MCP
   transport
