# ADR-0004: Companion ownership — agentic-plugins owns both

## Status

Accepted

## Context

omcc currently uses OpenAI's official `openai/codex-plugin-cc` plugin
to call Codex from Claude Code. Specifically, omcc-dev's
ensemble-protocol globs the cache path
`~/.claude/plugins/cache/*/codex/*/scripts/codex-companion.mjs` and
invokes that script with an XML-structured prompt.

This works but has structural issues:

1. **Third-party dependency** — agentic-plugins' bridging behavior is gated
   on a plugin owned by another organization (OpenAI). Breaking
   changes upstream break agentic-plugins silently
2. **Asymmetric** — there is no equivalent "claude-plugin-cc" for
   Codex CLI users to call Claude. If agentic-plugins wants bidirectional
   peer-agent invocation, the Codex→Claude direction must be built
   from scratch anyway
3. **Contract leakage** — the XML prompt format omcc uses is
   constrained by what `codex-companion.mjs` exposes (its CLI
   arguments, its output format), not by agentic-plugins' own design

For agentic-plugins to be a real framework with a defined contract, the
companion bridges must be agentic-plugins' own.

## Decision

agentic-plugins owns both companion bridges:

- `companions/codex-companion.mjs` — Claude → Codex peer-agent invocation
- `companions/claude-companion.mjs` — Codex → Claude peer-agent invocation

Both:
- Live in this repository
- Implement the same `companions/contract.md`
- Shell out to the appropriate peer-host CLI in headless mode (the
  `claude` and `codex` commands) — not to any third-party plugin
- Are versioned with agentic-plugins
- Are tested in `companions/tests/` for round-trip behavior

The marketplace catalogs (`.claude-plugin/marketplace.json`,
`.agents/plugins/marketplace.json`) advertise only agentic-plugins' own
plugins. They do NOT register `openai/codex-plugin-cc` or any other
third-party plugin.

Users who want OpenAI's user-facing slash commands like `/codex:review`
or `/codex:rescue` are directed by README to install
`openai/codex-plugin-cc` from OpenAI's marketplace separately. agentic-plugins
does not duplicate or wrap those commands.

## Consequences

**Positive**:
- agentic-plugins' behavior is fully self-contained — third-party version
  drift cannot break agentic-plugins
- The companion contract is owned by agentic-plugins; XML prompt structure,
  output parsing, error semantics all evolve under agentic-plugins' release
  cadence
- Symmetric design: both directions are first-party
- Cleaner test story: round-trip tests run in this repo without
  depending on which version of which third-party plugin is installed

**Negative**:
- agentic-plugins must track the underlying CLI evolution itself (Claude Code
  CLI flags, Codex CLI flags, headless mode contracts). When OpenAI or
  Anthropic ships a CLI breaking change, agentic-plugins' companion needs an
  update
- agentic-plugins does not benefit automatically from improvements to
  third-party plugins like `openai/codex-plugin-cc`
- Initial implementation cost: writing two companions and the contract
  spec is not free

**Neutral**:
- This ownership boundary does NOT preclude agentic-plugins users from also
  installing third-party plugins for user-facing UX (`/codex:review`
  etc.). agentic-plugins and `codex-plugin-cc` can coexist on a user's
  machine; agentic-plugins just doesn't depend on it

## Alternatives Considered

1. **Continue depending on `openai/codex-plugin-cc`** — Rejected. Third-
   party version coupling is a structural fragility. Also, no equivalent
   exists for the Codex→Claude direction, so half the work has to be
   built anyway

2. **Wrap `codex-plugin-cc` as a thin shim** — Rejected. A wrapper
   inherits the contract (XML format, output structure) of the wrapped
   plugin. agentic-plugins' contract should be agentic-plugins', not a wrapper of
   someone else's

3. **Recreate the user-facing slash commands (`/codex:review`,
   `/codex:rescue`) as agentic-plugins plugins** — Rejected for now. These
   are user-facing UX commands belonging to OpenAI's product. agentic-plugins'
   value is in the cross-host framework, not in re-implementing
   first-party UX. README will direct users to install
   `openai/codex-plugin-cc` separately if they want those commands

4. **Use MCP for peer-agent invocation, drop companions entirely** —
   Rejected. See ADR-0003 — MCP is wrong abstraction for peer-agent
   invocation
