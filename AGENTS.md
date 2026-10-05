# agentic-plugins — Development Guidance for AI Agents

This is the **primary** guidance for AI coding agents (Claude Code, Codex CLI,
Cursor, etc.) working on agentic-plugins. `CLAUDE.md` only points here, so both
hosts read one source (principle 1). It holds the rules you act on; reasons,
procedures and history live in the documents it links.

---

## What agentic-plugins is

A **cross-host AI agent collaboration framework**: plugins native to both
Claude Code and Codex CLI, where each host can call the other as a peer. It
has two faces of equal priority. The **external** face is what consumers
install: the companion CLIs (`companions/`), the dual-host plugins
(`plugins/`), the plugin authoring toolkit (`kit/`) and two marketplace
catalogs. The **internal** face is how it is developed: this file, `docs/`,
the tests that hold the adapter and companion contracts, and CI. agentic-plugins
is built with its own plugins (principle 4).

---

## Repository layout

```
agentic-plugins/
├── AGENTS.md · CLAUDE.md · README.md  # this guidance · its Claude hook · consumer charter
├── release-please-config.json         # the package registry (keys of `packages`)
├── .claude-plugin/marketplace.json    # Claude Code catalog
├── .agents/plugins/marketplace.json   # Codex CLI catalog, pinned to release commits (ADR-0061)
├── companions/        # the two bridges (Claude → Codex, Codex → Claude), contract.md v0.1.1 (ADR-0009)
├── plugins/           # dual-host plugins, 4-layer model (ADR-0010)
│   ├── attention/     # L1 hook-only: Claude Stop + SessionStart sensors for runtime (ADR-0040, 0045, 0064)
│   ├── companions/    # L1 script library: bundled companions + peer discovery (ADR-0008)
│   ├── runtime/       # L1 host readiness and operator control (ADR-0024, 0064)
│   ├── orchestrator/  # L2 macro plans, engineer dispatch, autopilot (ADR-0018, 0019, 0062, 0063)
│   ├── image/         # L2 image generation through Codex's integrated gpt-image only (ADR-0037)
│   ├── engineer/      # L3 software-engineering workbench (ADR-0010, 0020)
│   ├── founder/       # L3 new-business planning workbench (ADR-0036)
│   └── designer/      # L3 code-first design/UX workbench, accessibility veto (ADR-0042)
├── persona-pipeline/  # the persona plugins' shared scripts and hooks, one source, generated into each (ADR-0066)
├── kit/lint/          # plugin shape conformance checks
├── scripts/           # catalog/version/artifact validators, sync helpers, mutation harness
├── tests/             # node --test suite: per plugin, plus plugin-shape/, scripts/, cross-host/, acceptance/
├── .github/workflows/ # full-tests.yml, validate.yml, release-please.yml
└── docs/              # ARCHITECTURE.md · DEVELOPMENT.md (stage history) · adr/ (index: README.md)
                       # · runbooks/ · frozen records: assurance/, audits/, release-proofs/ (ADR-0065)
```

Each plugin carries a `README.md`, both host manifests (`.claude-plugin/`,
`.codex-plugin/`) and its own `CHANGELOG.md`. ADR-0013 is reserved for a
future Codex CLI command-integration mechanism.

---

## Architecture in one paragraph

agentic-plugins uses **Hexagonal architecture (ports and adapters)** applied
to AI agent plugins (ADR-0001), extended with a **4-layer composition model**
(ADR-0010); dependencies point down, L4 → L3 → L2 → L1:

1. **Layer 1 — Framework primitive**: `companions` (cross-host peer
   invocation), `runtime` (host readiness, operator control), `attention`
   (the hooks that feed runtime).
2. **Layer 2 — Capability**, persona-agnostic and reusable: `orchestrator`
   (macro planning and dispatch), `image`; `decision` is a reserved slot.
3. **Layer 3 — Persona / workbench**, the user-facing install unit composing
   capabilities through profiles: `engineer`, `founder`, `designer`.
4. **Layer 4 — Profile**: sub-discipline configuration data within a persona
   (e.g. `engineer:backend`, `designer:cta`).

Skills in L2/L3 plugins follow the **6 universal cognitive verbs**:
Investigate / Frame / Decide / Compose / Critique / Refine (ADR-0010). Names:
`<persona>:<verb>` for L3 (`/engineer:investigate`), `<capability>:<verb>`
for L2 (`/image:compose`), and `<capability>:<capability>` for a single-verb
capability (ADR-0010 §3; the retired `/research:research`, ADR-0014, was the
precedent). Profile and topic flow as arguments. Verb-level sugar aliases
within a plugin are permitted (`/engineer:audit` ≡ `/engineer:critique
--profile=full-codebase`); plugin-name level marketplace aliases are not
(ADR-0011 §Non-Goals item 9). Each host's **adapter** implements that host's
runtime model (manifests, hook events and payloads, orchestration,
continuity); the **companion** layer holds two bridges, one per direction.

**Runtime commands** (table: `plugins/runtime/README.md` §Commands):
`doctor`, `settings`, `context`, `bootstrap`, `dashboard`, `retention`,
`migrate`, `consensus` and `worktree`. `runtime:consensus` runs a bounded
multi-peer consensus on a real conflict (plan → `execute --execute` →
synthesize → `next-round` → decide, ratify or cancel; two rounds by default,
three at most, then the owner decides), and `runtime:worktree plan` lays out
how to isolate a slice in its own git worktree. Both are kept capabilities,
the tools for peers that conflict and for work that splits into independent
lanes. Runtime never loops consensus without bound, relaxes a host's
permissions, mutates a host session's context or Codex trust state, or puts
raw peer output in the main session.

---

## Conventions

### Commits — Conventional Commits

`<type>(<scope>): <description>`

Types: `feat`, `fix`, `docs`, `ci`, `refactor`, `chore`, `test`
Scope: subsystem name (e.g., `companions`, `kit`, `plugin/<name>`, `adr`, `docs`)

Examples: `feat(companions): add claude-companion XML output parser`,
`docs(adr): finalize ADR-0007 cutover plan`,
`test(kit): add adapter-contract conformance tests`.

### Branching — never commit to main

1. `git checkout -b <type>/<scope>`
2. commit on the branch
3. `git push -u origin <branch>`
4. open PR via `gh pr create`

### Pull strategy

Use **merge** for `git pull`. Run `git pull --no-rebase` explicitly. Do not
rely on bare `git pull` since `pull.rebase=true` in any config layer silently
rewrites history.

### Versioning

SemVer (MAJOR.MINOR.PATCH). MAJOR for breaking changes (companion contract,
adapter contract, manifest schema). MINOR for new plugins or new adapter
features. PATCH for fixes and docs.

### Release process

release-please versions each package, writing `.release-please-manifest.json`
and each plugin package's two `plugin.json` manifests (`extra-files`). The root
catalogs are deliberately not `extra-files` targets: after each release the
release-please workflow runs `scripts/sync-marketplace-versions.mjs`, which
writes each Claude entry's `version` and advances each Codex pin (ADR-0061).

- **Only the release commit may show its catalogs trailing the manifest**
  (ADR-0065 Decision 8); every other commit is validated strictly. A commit
  that lands on `main` while the release job runs stays red until the
  catalogs sync. Retry with a manual dispatch,
  `gh workflow run release-please.yml --ref main`, never a re-run of the
  failed job: release-please reports `releases_created` only once, so a
  re-run skips the sync.
- **A change under `plugins/runtime/data/` carries a release-routing type
  (`feat` or `fix`) on its squash subject.** Runtime commands read
  `plugin-set.json` and `schemas/**` from the *installed* plugin, so an
  unreleased edit changes nothing anyone runs. Review enforces this; nothing
  checks that the release happened (ADR-0065 Decision 5). Roll such an asset
  back with a forward patch, never by reusing or lowering a version.
- **On Codex, any package edit reaches an installed plugin only through a
  release and its pin**, on each machine that has passed ADR-0061 §Decision 5
  (b). Exercising an unreleased change there takes a release or a deliberate
  local override, which never enters the catalog. On a machine that has not
  passed it, "an unreleased edit changes nothing anyone runs" holds on Claude
  Code only, and there only for a version already materialized and not
  replaced.
- **After installing a `plugin-runtime` release on a host, run
  `runtime:doctor` with its proofs there** (`--permission-proof
  --execute-permission-proof --deep-peer-smoke --execute-deep-peer-smoke
  --workflow-continuation-proof --execute-workflow-continuation-proof`) and
  fix a failure forward. It is a habit, not a gate, and leaves no repository
  record (ADR-0065 Decision 2). Before `--record`, install the release on
  both hosts: they share `.agentic-plugins/runs/doctor/`, and an older runtime
  counts a newer artifact `malformed`. After a hook-bearing upgrade on Codex,
  review and trust the hooks in `/hooks`, then record it with
  `runtime:settings --attest-codex-hook-review`.

Merge hygiene and squash messages:

- For a single-package PR, prefer a squash merge whose message is the one
  intended changelog entry. When several release-routed commits must survive,
  use rebase merge if available, or keep the merge commit body from repeating
  the conventional headline: a merge commit that embeds a conventional PR
  title can be parsed alongside the branch commit, duplicating the changelog
  entry.
- **The squash message comes from the PR, not from the branch commits**
  (`squash_merge_commit_title=PR_TITLE`, `squash_merge_commit_message=PR_BODY`).
  The PR body **is** the commit body: write it as the record you want, and
  update it after a review changes the decision.
- Do not put a literal `BREAKING CHANGE:` line, or a bare conventional
  headline at the start of a line, into a PR body unless release-please should
  route it. Prose that mentions a breaking change is fine; a footer-shaped
  line is not.
- Merging from the CLI, pass both parts explicitly —
  `gh pr merge <n> --squash --subject "<title>" --body-file <path>` — so the
  message is correct even if the repository setting drifts.

The mechanics and incidents behind these rules (how the sync plans and
validates, why the release commit's CI is green, how a pin reaches a Codex
machine, the `16b1833` and `85fee0a` cases) are in
[`docs/runbooks/release-process.md`](docs/runbooks/release-process.md); pin
activation and sync refusals in
[`docs/runbooks/codex-pin-activation.md`](docs/runbooks/codex-pin-activation.md).

### Cross-package commit splitting

release-please routes a commit's footer (`feat`, `fix`, BREAKING CHANGE, etc.)
to **every** package whose tracked path the commit touches — Conventional
Commits scope is a label, not a routing override. When a single commit
modifies files in 2+ release-please package paths, **split into per-package
commits before pushing**, each staging only its package's files
(`git add <package-path> && git commit`).

The package paths are the keys of `release-please-config.json` `packages` —
currently `companions`, `plugins/attention`, `plugins/companions`,
`plugins/designer`, `plugins/engineer`, `plugins/founder`, `plugins/image`,
`plugins/orchestrator` and `plugins/runtime`. Files outside every package key
prefix are exempt: root files (`AGENTS.md`, `README.md`, `package.json`,
etc.), `docs/`, `scripts/`, `tests/`, `kit/`, `persona-pipeline/`,
`.claude-plugin/`, `.agents/`, `.github/` and any other unlisted path. Root-level docs may be folded into any
per-package commit or a separate docs-only commit at the author's discretion.
The exemption is structural, so it shrinks
automatically if a new package's path overlaps a previously exempt area.
Reviewers enforce this, not CI; a violation surfaces as a wrong release-please
PR (e.g. a BREAKING bump on an untargeted package). Rationale, the originating
`28b5eb8` incident and rejected alternatives:
[ADR-0016](docs/adr/0016-cross-package-commit-splitting.md).

### ADR process

1. Copy `docs/adr/template.md` to `docs/adr/NNNN-<slug>.md` (next number)
2. Fill out Status (start with `Proposed`), Context, Decision, Consequences, Alternatives Considered
3. PR for review; on merge change Status to `Accepted`
4. To supersede an ADR: create a new ADR that references the old one and change the old one's Status to `Superseded by ADR-NNNN`

---

## Development principles

These are repo-wide rules. Plugin-specific conventions go in each plugin's own
`CLAUDE.md`/`AGENTS.md`.

### 1. Standards-aligned core

When a capability has both a host-specific and an open-standard
implementation, the standard goes in `core/` and the host-specific one in the
adapter: Skills → Agent Skills standard (agentskills.io) → core; Tools → MCP
→ core; Hooks → host-specific event names → adapter; Subagents → persona
description in core, host format (markdown+YAML or TOML) generated in the
adapter.

### 2. Layered separation, not thin adapter

Adapters are **as thin as possible, but no thinner**: they contain whatever
honoring core intent within the host's runtime model takes, and some are
substantial (e.g. orchestration that needs host-specific subagent
invocation). Do not force false unification.

### 3. Companion contract is the framework

Both companions (`claude-companion`, `codex-companion`) implement
`companions/contract.md` — XML prompt structure, output parsing, error
semantics — the inviolable contract. Adapters call companions only through it,
never through ad-hoc shell wrapping.

### 4. Dogfooding

agentic-plugins is developed with its own plugins, as it has been since
`plugins/engineer` drove its own development at the Stage 2 exit: one
deliverable through `/engineer:start` (or a single verb), several through
`/orchestrator:plan`, then `/orchestrator:next` per subtask. Real-use findings
feed the next change. History: `docs/DEVELOPMENT.md`.

### 5. Honest scope

If a feature cannot be made native+canonical in both hosts, document the limit
rather than force false unification — in particular for host-specific runtime
semantics (auto-delegation, context lifecycle events, statusline, etc.). See
ADR-0001 final note.

---

## Build / test / CI

- `npm test` — full Node test suite via `node --test` discovery (ADR-0033);
  conventionally-named new test files are picked up automatically.
  `npm test -- <files>` runs a subset (`npm test -- tests/cross-host/test-*.mjs`).
- `npm run test:smoke` — the companion smoke tests
  (`companions/tests/*.smoke.mjs`, outside discovery).
- `npm run lint:plugin-shape` — validate every plugin directory with `kit/lint`.
- `npm run validate:marketplace`, `validate:versions`, `validate:artifacts` —
  catalog, release-please manifest and generated-artifact ignore policy
  consistency. `validate:marketplace` also checks the Codex catalog's ADR-0061
  Decision 2 phase against `scripts/data/codex-pin-floors.json`; it needs full
  history and tags and fails closed without them, and `-- --base <rev>` adds
  the monotonic-pin comparison against a baseline catalog.
- `npm run sync:companions`, `npm run sync:marketplace` — drift correction.
- `npm run sync:persona-pipeline` — check that every persona plugin's generated
  copy of the shared scripts and hooks matches its canonical source in
  `persona-pipeline/`, and that each `persona.json` declaration passes
  (ADR-0066); `-- --write` regenerates. Edit the source, never a generated copy
  (each carries a "GENERATED by persona-pipeline" notice). A pipeline change
  releases every persona whose generated files it changes, one commit per
  package; `persona-pipeline/` is exempt and rides with the first.
- `npm run mutate -- <spec>` — run a mutation spec from
  `scripts/mutation-specs/`. A green suite is not evidence that it tests
  anything; the harness breaks the tree on purpose and scores each defect
  against a stated expectation. Each mutation runs in its own disposable copy
  of HEAD **plus the working tree** (the gates derive their repo root from
  `import.meta.url`, so editing in place or changing cwd proves nothing). It
  refuses to score an edit whose anchor drifted, or anything when the
  unmutated control is not green. How the copy is made: the header of
  `scripts/mutation-harness.mjs`.

GitHub Actions run on Node 24. `full-tests.yml` runs the full `npm test` once,
with no path filter: it is the only workflow that runs tests, and the
repo-level coverage authority (ADR-0033). `validate.yml` runs the non-test
checks: `lint:plugin-shape`, the persona-pipeline drift check and the three
validators, with `--base` set to
main's previous commit on a push to `main` and to the branch's fork point on
`main` on a push to any other branch (a manual dispatch compares no
baseline). Both run on a push to any branch and on `workflow_dispatch`,
never on `pull_request` (GitHub holds those runs for approval on
release-please's `GITHUB_TOKEN`-updated PR, where they failed with zero jobs).
A pull request shows its head commit's push run; fork pull requests get no CI;
a branch cut before 2026-10-03 needs a rebase onto `main`, a merge of it, or a
manual dispatch (ADR-0033 amendment of that date). `release-please.yml` runs on
a push to `main` and on manual dispatch.

---

## Current state and next session

Stages 0–2 are complete, and the owner declared the omcc → agentic-plugins
cutover on 2026-06-03 (ADR-0007, ADR-0012). Stage 2.5+ resumes with ADR-0013
when its trigger fires (a Codex CLI plugin-commands schema lands, or another
mechanism is designed); Stage 3+ continues in small PRs, with the
runtime/operator track (ADR-0024) fed by real-use findings. Stage history,
exit evidence and the cutover record are in `docs/DEVELOPMENT.md`; shipped
versions in `.release-please-manifest.json`, the package changelogs and the
release tags.

To start a session:

1. Read this file, then `docs/ARCHITECTURE.md`, then the ADRs your change
   touches (index: `docs/adr/README.md`). The usual ones: 0010 (plugin
   boundaries, layers, verbs), 0016 (release routing), 0019 (orchestrator ↔
   engineer dispatch), 0024 (runtime), 0062 (subtask completion at landing),
   0063 (autopilot), 0065 (release ceremony).
2. Resume the active workflow with `/engineer:resume` or
   `/orchestrator:resume` (on Claude Code, the SessionStart entry brief names
   it when the owner has enabled it).

A stale `research@agentic-plugins` 0.1.0 install from agentic-plugins ≤0.3.x
is reported by `runtime:doctor`; remove it with
`claude plugin uninstall research@agentic-plugins` (or the Codex equivalent).
The plugin left both catalogs with ADR-0014/0015.

---

## License

[MIT](LICENSE).
