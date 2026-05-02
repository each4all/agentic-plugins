# ADR-0006: Directory layout + install pattern

## Status

Accepted

## Context

Two existing reference projects took different approaches to multi-host
support:

- **gstack** (Garry Tan): per-host adapter directories
  (`gstack/claude/`, `gstack/codex/`, etc.) sharing a common
  `lib/`/`browse/`/skill implementations. Install via single `./setup
  --host <name>` script that auto-detects host. SKILL.md generated
  per-host at setup time
- **superpowers** (Jesse Vincent): host-native install commands per
  platform (`/plugin install ...`, `gemini extensions install ...`,
  etc.). Multiple host-specific manifest directories at repo root
  (`.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/`). Single
  SKILL.md file per skill (Agent Skills standard)

agentic-plugins needs to choose a directory layout and install pattern that
fits its principles (standards-aligned core, layered separation, native
in each host).

## Decision

### Directory layout — adopt gstack-style per-host adapter directories

```
agentic-plugins/
├── README.md
├── AGENTS.md
├── CLAUDE.md
├── .claude-plugin/
│   └── marketplace.json              # Claude marketplace catalog
├── .agents/
│   └── plugins/
│       └── marketplace.json          # Codex marketplace catalog
├── companions/                       # Bidirectional bridges
├── kit/                              # Plugin authoring toolkit
├── plugins/
│   └── <plugin-name>/
│       ├── .claude-plugin/plugin.json     # Claude manifest
│       ├── .codex-plugin/plugin.json      # Codex manifest
│       ├── skills/<skill>/SKILL.md        # CORE: Agent Skills standard
│       ├── personas/<agent>.md            # CORE
│       ├── mcp-servers/<server>/          # CORE
│       ├── prompt-templates/              # CORE
│       └── adapters/
│           ├── claude/
│           │   └── hooks/hooks.json
│           └── codex/
│               ├── hooks/hooks.json
│               └── agents/<agent>.toml
└── docs/
```

Per-host adapter content is isolated under `plugins/<n>/adapters/{claude,codex}/`.
Host-neutral CORE content lives directly under the plugin (skills/,
personas/, mcp-servers/, prompt-templates/).

### Install pattern — adopt superpowers-style native per-host install

Each host uses its own native plugin manager. agentic-plugins does not provide
a unified `./setup` script.

```
# Claude Code
/plugin marketplace add each4all/agentic-plugins
/plugin install <plugin>@agentic-plugins

# OpenAI Codex CLI
codex plugin marketplace add each4all/agentic-plugins
# (per Codex CLI native commands; Codex's exact install UX TBD per
#  current Codex version at time of first release)
```

### SKILL.md handling — single file per skill, shared across hosts

SKILL.md is the Agent Skills open standard. The same SKILL.md file
serves both Claude Code and Codex CLI (both implement the standard).
agentic-plugins does NOT generate per-host SKILL.md variants. If a host needs
host-specific guidance, that goes in the adapter, not in a new SKILL.md
copy.

## Consequences

**Positive**:
- Per-host adapter isolation (gstack pattern) keeps host-specific code
  contained and easy to audit
- Native install per host (superpowers pattern) honors each host's UX
  and avoids "feels off" wrapper scripts
- Single SKILL.md per skill (Agent Skills standard) eliminates drift
  risk
- Marketplace catalogs at repo root means `/plugin marketplace add
  each4all/agentic-plugins` and `codex plugin marketplace add each4all/agentic-plugins`
  both work without users needing to know subdirectory paths

**Negative**:
- Two marketplace catalog files to maintain (one per host) — though
  these are mostly auto-generatable from the plugins list
- Users of two hosts run two install commands (one per host). No
  unified install
- Per-host adapter directory means more files, more review surface for
  multi-host changes

**Neutral**:
- This layout assumes Claude Code and Codex CLI as the initial two
  hosts. Adding a third host (Cursor, Goose, etc.) means:
  - Adding a third host's marketplace catalog at root if applicable
  - Adding `plugins/<n>/adapters/<new-host>/` per plugin
  - Documenting native install command in README

## Alternatives Considered

1. **gstack-style unified `./setup --host` script** — Rejected.
   superpowers' native-per-host install is more standards-aligned
   (uses each host's own plugin manager) and matches agentic-plugins'
   "honor host runtime contract" principle

2. **superpowers-style flat repo with multiple `.<host>-plugin/` at
   root** — Considered. Works for skill-only frameworks but doesn't
   scale to per-plugin host-specific code (hooks, agents). gstack's
   per-host adapter directories per plugin scales better

3. **Generate per-host SKILL.md files at install time (gstack
   pattern)** — Rejected. SKILL.md is an open standard; both hosts
   read it natively. Generating per-host variants risks drift and
   defeats the standard

4. **Single root manifest that points to all plugins** — Rejected.
   Each host expects its own manifest format at its own location.
   Trying to unify these breaks the marketplace install path
