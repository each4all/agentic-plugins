# agentic-plugins — Development (Meta)

This document describes **how agentic-plugins is itself developed**. It is the
internal-face counterpart to `README.md` (which targets consumers) and
`docs/ARCHITECTURE.md` (which targets users of the framework).

agentic-plugins is built so it can build itself. This document explains the
plan for that.

---

## Why this document exists

agentic-plugins has two faces:

1. **External face** — published companions, plugins, kit, marketplace catalogs
2. **Internal face** — tooling that supports agentic-plugins' own continuous development

A framework that ships to others must also be sustainable for its own
maintainers. omcc has `omcc-dev` for this purpose; agentic-plugins needs an
equivalent. This document lays out the plan, including the dogfooding
transition.

---

## Initial development host

Until agentic-plugins has its first published plugin stable enough to
self-serve, **agentic-plugins development uses Claude Code as the primary host**
and `omcc-dev` as the workflow framework.

Concrete:
- New work happens in Claude Code sessions in this directory
- Workflows go through `omcc-dev`'s `/start`, `/fix`, `/audit`, etc.
- The session reads `AGENTS.md` (via Claude Code's `CLAUDE.md` → `@AGENTS.md` redirect) for project conventions
- ADR proposals follow the process documented in `AGENTS.md`

This is **transitional**. Once agentic-plugins has its own equivalent plugin
(see "Dogfooding plan" below), agentic-plugins switches to itself.

---

## Dogfooding plan

The strategic intent is for agentic-plugins to develop agentic-plugins. The path:

### Stage 0 — Scaffolding (current)

- Repository structure exists
- All 7 ADRs accepted (0001–0007)
- Tooling decided: Node + pnpm + vitest + prettier + GitHub Actions + release-please + MIT
- No plugins yet
- No companions yet
- Development happens in Claude Code with omcc-dev as the workflow framework

### Stage 1 — Reference plugin and companion contract

- Companion contract finalized in `companions/contract.md`
- One small reference plugin shipped — references omcc-research's experience (single skill, ensemble protocol, graceful degradation), but plugin name, skill structure, and command surface are agentic-plugins' own design (not a 1:1 port — see ADR-0007)
- Both adapters (Claude, Codex) implemented for the reference plugin
- Smoke tests pass in both hosts via `kit/lint/` and `companions/tests/`
- Both companion CLIs (`claude-companion`, `codex-companion`) implemented

### Stage 2 — Self-development plugin

- A new agentic-plugins plugin ships (name TBD — not constrained to mirror omcc-dev):
  - References omcc-dev's workflow experience (`/start`, `/fix`, `/audit`, brainstorm, continuity, ensemble, etc.) — keep what works, redesign what doesn't, scope to what genuinely benefits from dual-host
  - Uses agentic-plugins' own framework (skills + adapters + companions)
  - Implements orchestration natively per host (Claude auto-delegation, Codex explicit-dispatch)
- agentic-plugins development workflows switch from `omcc-dev` to this plugin
- The omcc-dev dependency for agentic-plugins development is dropped

### Stage 3 — Design domain and remaining workflows

- A design-domain plugin ships, referencing omcc-designer's experience (poster, social-graphics, frontend, brief, evaluation, etc.) with the same redesign stance
- Any omcc-dev workflow patterns not covered in Stage 2 are addressed (implemented or explicitly dropped with rationale)
- The user's daily workflows have agentic-plugins equivalents preferred over omcc
- omcc archived per ADR-0007's archive procedure

Cutover happens after Stage 3 exit criteria are met. See
[`adr/0007-migration-cutover-plan.md`](adr/0007-migration-cutover-plan.md)
for the cutover plan.

---

## Tooling

Decisions made 2026-05-02:

### Runtime and package management

- **Node** for companions and adapter scaffolding (`claude-companion.mjs`, `codex-companion.mjs`)
- **pnpm** as package manager — workspace-friendly for the monorepo (`companions/`, `kit/`, `plugins/<name>/`)
- **plain `.mjs`** (no TypeScript initially) — companions are small CLI shell-outs; introduce TS later if complexity demands
- No Python expected at this stage

### Test framework

- **vitest** for both unit and round-trip tests
- Companion round-trip tests invoke real `claude` / `codex` CLIs in CI — separate per-host workflow gates so each can fail independently
- Adapter conformance tests are pure unit tests (`kit/lint/`)

### CI

- **GitHub Actions**
- Per-host workflow gates: `claude-tests.yml`, `codex-tests.yml` — each can fail independently without blocking the other host's release
- Separate marketplace JSON validation workflow (cheap)

### Lint / format

- **prettier** for formatting (light footprint)
- eslint / biome added later if/when needed

### Release automation

- **release-please** (matches omcc precedent)
- SemVer with conventional-commits-driven version bumps
- Note: dual marketplace means dual catalog updates per release

### License

- **MIT** (matches omcc, simple and permissive)

---

## Quality bar for "actually works"

Adapted from the second research brief's "Phase exit criteria" section:

| Stage | Exit condition |
|---|---|
| Scaffolding | All ADRs 0001–0007 accepted; tooling decisions made |
| Reference plugin (Stage 1) | Reference plugin install→invoke→complete on both hosts; round-trip companion call passes; CI gates green per host |
| Self-development plugin (Stage 2) | Self-development plugin can drive agentic-plugins' own development workflow on both hosts; omcc-dev no longer required for agentic-plugins development |
| Cutover (after Stage 3) | All Stage 1–3 milestones met; user confirms ≥1 week sustained use without regression and with at least one clear improvement; omcc archive ready (per ADR-0007) |

Each stage's exit is **demonstrated working behavior**, not "code exists".

---

## Risks to track

These will get their own follow-up notes (probably as ADRs or DEV log
entries) when they materialize:

1. **Codex CLI evolves rapidly** — companion contract may need to adapt to new Codex versions. Mitigation: pin to specific Codex version ranges; track Codex changelog
2. **Agent Skills standard evolves** — SKILL.md frontmatter may gain/lose fields. Mitigation: validate skills against current spec in CI
3. **${CLAUDE_PLUGIN_ROOT} bug class in Claude Code** — known to fail in SessionStart hooks and Bash tool context. Mitigation: avoid relying on it for Claude adapter; use absolute paths derived at install time
4. **Bidirectional companion auth** — `claude` and `codex` both require credentials. Companion needs a story for non-interactive auth in CI. TBD
5. **omcc-dev's PreCompact-based continuity has no Codex equivalent** — see ADR-0007 stub

---

## Contributing (future)

Once agentic-plugins opens to external contributors:
- All changes via PR (no direct commit to main)
- ADRs for substantive design decisions
- Tests required for new adapter or companion features
- Documentation kept in sync with code

For now: solo development, but the conventions above are observed for
self-discipline.
