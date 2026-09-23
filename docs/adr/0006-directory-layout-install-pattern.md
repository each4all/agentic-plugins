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
│       ├── core/                          # CORE (see 2026-09-18 Amendment)
│       │   ├── skills/<skill>/SKILL.md    #   Agent Skills standard
│       │   ├── personas/<agent>.md
│       │   ├── mcp-servers/<server>/
│       │   └── prompt-templates/
│       └── adapters/
│           ├── claude/
│           │   └── hooks/hooks.json
│           └── codex/
│               ├── hooks/hooks.json
│               └── agents/<agent>.toml
└── docs/
```

Per-host adapter content is isolated under `plugins/<n>/adapters/{claude,codex}/`.
Host-neutral CORE content lives under the plugin's `core/` tree
(`core/skills/`, `core/personas/`, `core/mcp-servers/`,
`core/prompt-templates/`) — amended 2026-09-18; it previously lived
directly under the plugin. Of the four categories only `core/skills/`
has ever carried files, so the relocation touches only that one.

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

**Sharing the file is not the same as registering it** (clarified by the
2026-09-18 Amendment). One SKILL.md still serves both hosts and there are
still no per-host variants. What differs is how each host reaches it:
Codex resolves the skills root from `.codex-plugin/plugin.json` `skills`,
while Claude Code registers whatever it finds at the conventional
`plugins/<n>/skills/` path with no manifest declaration at all. Placing
the shared file under `core/skills/` and declaring that root in the Codex
manifest only is what lets one file serve both hosts while appearing in
exactly one host's skill registry.

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


## Amendments

### 2026-09-18 — CORE content moves under a named `core/` root, and only the Codex manifest points at it

**Trigger**: this ADR put CORE content "directly under the plugin", which
placed `skills/<skill>/SKILL.md` on exactly the path Claude Code registers
by convention, with no manifest declaration. The consequence was measured
with Claude Code 2.1.276's own accounting
(`claude --plugin-dir <dir> plugin details <name>`): across the six
skill-bearing plugins Claude registered **112 components (57 commands + 55
skills)** for **~15,431 always-on tokens per session**, every capability
appearing twice — once as its command and once as its skill. For
`plugins/image` alone that read `Skills (12)` / `~1,183 tok`. Codex has no
such duplication: it resolves its root from the manifest.

**What changed**: host-neutral CORE content moves from `plugins/<n>/<category>/`
to `plugins/<n>/core/<category>/`. Each plugin's `.codex-plugin/plugin.json`
`skills` key — which all eight already declare — points at `./core/skills/`.
The Claude manifest stays silent, as it already is, so the conventional path
holds no `SKILL.md` and Claude registers zero skills, while Codex keeps
resolving all 55 from its declared root — the resolution path it already
uses, and the one `kit/lint` checks exists. A relocated copy of `plugins/image` measured `Skills (6)` /
`~232 tok`, the six survivors being its commands. The name `core/` is not
new vocabulary: `AGENTS.md` §1 already states the principle as "Skills →
Agent Skills standard → core", and this ADR's own tree annotated the
category `# CORE`.

**What did not change**: SKILL.md remains one shared file per skill, with no
per-host variants — the §"SKILL.md handling" rule above is clarified, not
superseded. Claude keeps every one of its 57 slash commands, and each command
runbook still reads its skill by explicit path; that is a file read, not
directory-convention registration, so it works from the new location. The
per-host adapter isolation, the native-install pattern, and the two
marketplace catalogs are untouched. `personas/`, `mcp-servers/` and
`prompt-templates/` are restated under `core/` for coherence but have never
held a file, so nothing relocates for them.

**Scope of the relocation**: six packages (`designer`, `engineer`, `founder`,
`image`, `orchestrator`, `runtime`), landing one per commit so release-please
routes each to its own package (ADR-0016). `attention` and `companions` are
**not** in scope: they hold no functional skills, they keep declaring the
conventional root, and their `skills/README.md` placeholders — the ADR-0008
§(a) Codex spec-compliance carve-out — stay exactly where they are.

**The tombstone is a mechanism, not documentation.** A relocated plugin keeps
an empty `skills/` directory holding only a README. Measured on the same
fixture: with that directory deleted, a plugin-root `SKILL.md` becomes
discoverable again (`Skills` 6 → 7); with it present, the same file is not
registered. A per-skill symlink left at the conventional path re-registers
the skill (6 → 7, ~232 → ~389 tok). Both shapes, and a duplicate `SKILL.md`,
passed `kit/lint` silently before this amendment;
`check-plugin-shape.mjs` now enforces the invariant for any plugin whose
declared root is not the conventional one.

**Observed after release (2026-09-23).** The fixture numbers above were
predictions; the releases are what a host actually loads. Installed from them
(image 0.3.1, engineer 0.21.10, designer 0.3.8, founder 0.4.8, orchestrator
0.13.7, runtime 0.97.4), Claude Code 2.1.280 reports **57** components across
the six plugins — exactly their 57 command files, each capability once — for
~3,311 always-on tokens, against the 112 / ~15,431 measured before release on
2.1.276, so the token difference also carries a host-version change. Codex
0.156.1's own `skills/list` resolves all **55** skills, every one from
`core/skills/`, with no load errors, and a live `$engineer:frame` mention
injected the relocated file. None of the 55 appears in the model-visible
implicit list, and that is by design: each opts out through `policy` in its
`agents/openai.yaml`. The measurements, their controls, and the proof run are
in `docs/assurance/omcc-cutover-scorecard.md` and in the evidence record
`the-capabilities-claude-registered-twice`.

**Rollback.** Pause when any of these is observed on an installed host: a
relocated plugin's Claude component list stops matching its command files by
name and count — a missing command as much as a re-registered skill; Codex
`skills/list` stops resolving each plugin's expected skills by name, enabled,
from `core/skills/`, or reports a load error; a command runbook's
`$CLAUDE_PLUGIN_ROOT/…` reference does not resolve in the installed cache; or a
persona's decide registry falls back (a `registry:` diagnostic, or a preset
defined only in the file degrading to the in-code default). The last-known-good
release of each package — its last release whose skills still lived at the
conventional root — is image 0.3.0, engineer 0.21.8, designer 0.3.7, founder
0.4.7, orchestrator 0.13.6 and runtime 0.97.3. They name what an affected host
would temporarily fall back to. Pinning one plugin to an older release has not
been exercised on either host, and such a fallback is not complete when the
host merely reports the older version. The cross-plugin discovery helpers
(`discover-engineer.mjs`, the `discover-runtime.mjs` copies, companions'
`discover-peer.mjs`) start from their own host's location and do not consult
its install registry. In Claude's plugin cache they take the highest retained
version; on Codex they read one fixed path, the marketplace checkout under
`~/.codex/.tmp/marketplaces/`, which follows `main`. Each resolved path
therefore has to be checked in a fresh session, or pinned through the helper's
override and checked again: `AGENTIC_ENGINEER_ROOT` and `AGENTIC_RUNTIME_ROOT`
take a plugin root, while `AGENTIC_COMPANIONS_ROOT` takes the companions
`scripts/` directory. Rolling back a hook-bearing package also stales the Codex
`/hooks` attestation, which then needs a new review and proof. The recovery
itself is a forward patch that keeps `core/skills/` as the destination and
ships under a new version. Moving files back under a reused or lowered version
is ruled out, because one version would then name two different trees — the
failure ADR-0051 rules out for protected assets.
