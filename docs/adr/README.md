# Architecture Decision Records (ADRs)

This directory contains the foundational architectural decisions for
agentic-plugins. Each ADR captures one decision with its context, the chosen
direction, and the consequences.

## Format

ADRs follow the standard 5-section format:

1. **Status** — `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, `Deprecated`
2. **Context** — Forces at play and why a decision is needed
3. **Decision** — What was decided
4. **Consequences** — What follows from the decision (positive, negative, neutral)
5. **Alternatives Considered** — What else was on the table and why rejected

See [`template.md`](template.md) for the canonical layout.

## File naming

`NNNN-<kebab-case-slug>.md` where `NNNN` is a zero-padded sequence
number starting at 0001. Numbers are never reused. To replace a
decision, write a new ADR with `Status: Accepted` that references the
old one, and change the old one's status to `Superseded by ADR-NNNN`.

## Process

1. Copy `template.md` to `NNNN-<slug>.md` (next number)
2. Status starts as `Proposed`
3. Discuss / iterate
4. Merge with `Status: Accepted`
5. To supersede: new ADR + update old ADR's status

### Amendments vs Supersedes

When an Accepted ADR needs revision, the choice between *Amendment*
(adding to the existing ADR) and *Supersede* (writing a new ADR
that replaces all or part of the old one) follows a single
discriminator:

- **Amendment** — the original Decision-section prose remains
  *operatively accurate* after the change. The Amendment adds
  clarifications, sub-finding additions, or downstream cascades
  that follow from the original Decision. Pattern: ADR-0008's
  Amendments (additive clarifications), ADR-0010's 2026-05-06
  Amendment (downstream cascade from ADR-0014/0015).
- **Supersede** — the original Decision-section prose is
  *no longer operatively accurate*. A reader landing on the old
  ADR must be pointed at the new one for the operative decision.
  Pattern: ADR-0015 supersedes ADR-0014's timeline portion;
  ADR-0014's Decision §1 ("plugin remains installable through
  Stage 3 entry") is reversed.

Partial supersedure is supported: if an ADR's Decision sections
divide cleanly (e.g., capability decision vs timeline), the old
ADR's Status becomes `Superseded by ADR-NNNN (X portion only)` and
the new ADR scopes its supersedure to that portion. ADR-0014/0015
is the precedent.

When in doubt, ask: *does the original Decision-section prose remain
operatively accurate?* If no, write a new ADR (Supersede).

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-hexagonal-architecture.md) | Hexagonal architecture (core / adapter / companion) | Accepted |
| [0002](0002-adapter-contract.md) | Adapter contract — 4 required items | Accepted |
| [0003](0003-mcp-vs-companion.md) | MCP vs companion-CLI — when to use which | Accepted |
| [0004](0004-companion-ownership.md) | Companion ownership — agentic-plugins owns both | Accepted |
| [0005](0005-separate-repo-from-omcc.md) | Separate repo from omcc | Accepted |
| [0006](0006-directory-layout-install-pattern.md) | Directory layout + install pattern | Accepted |
| [0007](0007-migration-cutover-plan.md) | Migration cutover plan from omcc to agentic-plugins | Accepted |
| [0008](0008-companion-distribution-model.md) | Companion distribution model — `companions` plugin + cache-glob discovery + env override | Accepted |
| [0009](0009-companion-contract-v0-1-1-prompt-file-stdin-precedence.md) | Companion contract v0.1.1 — `--prompt-file` and `PROMPT_ARG` precedence over stdin | Accepted |
| [0010](0010-plugin-boundary-policy.md) | Plugin boundary policy — 4-layer composition + universal cognitive verbs + naming convention | Accepted |
| [0011](0011-workflow-continuity-storage.md) | Workflow continuity storage — minimal Option III for Stage 2 | Accepted |
| [0012](0012-omcc-removal-preconditions.md) | omcc + codex-plugin-cc removal preconditions | Accepted |
| 0013 | Codex CLI commands integration mechanism (file pending — Stage 3+ trigger) | Reserved |
| [0014](0014-plugins-research-deprecation.md) | plugins/research deprecation — capability folded into engineer:investigate cited-brief profile | Superseded by [ADR-0015](0015-research-archive-timeline-collapse.md) (timeline portion only) |
| [0015](0015-research-archive-timeline-collapse.md) | Research archive timeline collapse — supersedes ADR-0014 timeline portion | Accepted |
| [0016](0016-cross-package-commit-splitting.md) | Cross-package commit splitting for release-please routing | Accepted |
| [0017](0017-stage25-continuity-and-schema-roadmap.md) | Stage 2.5+ continuity and schema roadmap (meta commands + `ensemble_results` frontmatter + Stop auto-archive) | Accepted |
| [0018](0018-stage3-architecture-orchestrator-and-branch-context.md) | Stage 3+ architecture — orchestration capability + branch-as-workflow-context + cross-host verification | Accepted |
| [0019](0019-cross-plugin-invocation-contract.md) | Cross-plugin invocation contract — orchestrator → engineer (Stage 3+ §sub-1 follow-up) | Accepted |
| [0020](0020-engineer-integrated-workflow-umbrella.md) | engineer integrated workflow umbrella — `/engineer:start` lifecycle macro command | Accepted |
| [0021](0021-codex-command-surface-parity-via-skill-wrappers.md) | Codex command-surface parity via skill wrappers — macro skill category alongside verb skills | Accepted |
| [0022](0022-engineer-meta-skill-category.md) | engineer meta-skill category — third category in `skills/<plugin>/` for workflow-continuity ops | Accepted |
| [0023](0023-peer-runner-supervisor-layer.md) | Peer-runner supervisor layer for companion dispatch | Accepted |
| [0024](0024-runtime-operator-control-plane.md) | Runtime operator control plane — doctor/settings, dynamic consensus, context hygiene, and host readiness | Accepted |
| [0025](0025-workflow-storage-migration.md) | Workflow storage migration to `.agentic-plugins` | Accepted |
| [0026](0026-runtime-compatibility-drift-and-release-notes.md) | Runtime compatibility drift and release-note evidence | Accepted |
| [0027](0027-decide-skill-multi-axis-evolution.md) | Decide skill multi-axis evolution — axis registry, sizing, weighting/sensitivity, and the parallel-edit contract | Accepted |
| [0028](0028-engineer-phase7-commit-automation.md) | Engineer Phase 7 commit automation — 3-layer defense + 14 policy sections + centralized validate-commit.mjs | Accepted |
| [0029](0029-entry-routing-contract-enforcement.md) | Extend entry-routing contract enforcement to standalone verbs — active, evidence-based next-action guidance | Accepted |
| [0030](0030-codex-plugin-hooks-removal-stage-aware-migration.md) | Codex `plugin_hooks` removal — stage-aware runtime migration | Accepted |
| [0031](0031-session-level-active-handoff-layer.md) | Session-level active handoff layer — projection model composing context risk + workflow state + routing into a continue-vs-fresh decision | Accepted |
| [0032](0032-codex-per-plugin-command-surface-adoption.md) | Codex per-plugin command surface adoption — stage-aware runtime recognition | Accepted |
| [0033](0033-ci-full-test-suite-coverage.md) | CI full-suite coverage via test discovery — no-arg `npm test`, unfiltered full-tests gate, smoke namespace split, structural guard | Accepted |
| [0034](0034-codex-plugin-list-read-signal.md) | Codex `plugin list --json` as host-native installed-state read signal — list-authoritative-then-cache precedence, shared resolver, doctor-scoped (cross-script deferred) | Accepted |
| [0035](0035-runtime-active-execution-boundary-policy.md) | Runtime active-execution boundary policy — read-only default, R0/M1/H2/H3 mutation tiers (no open-ended higher tier), per-executor invariants, testable `MUST NOT` ceiling (registry+static-test enforcement planned), add-gate; Codex `codex plugin add` (C) as H2 worked example, `--apply-codex-plugin-hooks` flagged obsolete/non-conformant | Accepted |
| [0036](0036-founder-persona-business-planning.md) | founder persona (L3) — new-business planning workbench: business profiles/axes/taxonomy, git-substrate lifecycle, staged decision-L2 seam | Accepted |
| [0037](0037-image-capability-plugin.md) | `image` capability plugin (L2) — cross-host image generation via Codex's **integrated** gpt-image (native + `codex-companion` bridge, shared-fs artifact, text pointer); full six-verb, domains-as-profiles, prompt-mediated params (direct OpenAI API out of scope); applies ADR-0010 §6 Trigger 2 + §7 | Accepted |
| [0038](0038-runtime-permission-prompt-advisory.md) | Runtime permission-prompt reduction advisory — A (doctor R0 diagnosis + settings M1 dry-run plan) + C (usage-grounded recommendations, sanitized evidence) base, application stays with the user (no host-config write, §4 ceiling preserved); Guard Hook (B) **out of scope** — deferred to a separate effect-based ADR that must amend ADR-0035 §4 (shipping a permission-relaxing component is forbidden "independent of any flag"; flagged by adversarial cross-host review) | Accepted |
| [0039](0039-completion-footer-activation.md) | Completion/handoff footer activation — wire the orphaned `footer.mjs` render engine into the already-code-spoken ADR-0031 sidecar terminal path via **subprocess piggyback** (not a `/runtime:footer` command), promoting completion elements 2/3/4/7/8 from prose to code on engineer + orchestrator; `--context-state` (not `--risk`), stderr/file-only, `execFile` capture→stderr, `emitted===true` gate, single-emission guard, `discoverRuntimePluginRoot` copy-not-import, fail-closed silent; orchestrator fixed-literal removal + ADR-0029 shape as a separate deliverable; founder **deferred** with an onboarding recipe (both decisive 9-axis + independent cross-host peer converged) | Accepted |
| [0040](0040-operator-observability.md) | Operator situational awareness — (A) attention notifications: runtime-owned emitter core (shared event schema, source-excluded dedupe key + kind/subject mapping contract, atomic TTL claims; **built-in allowlisted channels** `none`/`macos-osascript` (`on run argv`, payload never in AppleScript source)/`file-log`; ADR-0035 §4 ceiling untouched — exercises §2's new-ADR executor path, classifying fixed-argv dispatch + notify-state retention as a bounded M1 extension w/ an explicit narrow §3-invariant amendment scoped to the emit executor; custom-argv channel deferred to a future §4-amending decide-by-effect ADR per 0038 §6) + tiny **hook-only L1** `plugins/attention` (ADR-0010 §6 Trigger 2; ADR-0008-style shape formalization) Claude sensors (`Notification` w/ `notification_type` matcher, `Stop`, `SubagentStop`; freshness-checked sidecar enrichment) + Codex via M1 fragment plans (`notify=` source-verified turn-complete-only single-key, stable receiver-shuttle constraint; approval attention via `tui.notifications`; `PermissionRequest` hook deferred w/ trigger) + peer-run terminal self-sensor ×3 persona peer-runners (incl. orchestrator pre-ledger path; `pruned` skipped); (B) `runtime:dashboard` Tier 1+2 — 3-persona state (founder via direct namespace scan, doctor contract untouched) + operator health (pull-side) on extracted doctor readers; snapshot + bounded `--watch`; fail-closed silent, runtime stays hook-free (this ADR's decision) | Accepted |
| [0041](0041-cross-machine-notification-egress.md) | Cross-machine notification egress — **amends ADR-0035 §4 head-on** to add exactly one new effect domain, **tier E1 (enumerated-metadata network egress)**: a `notify.mjs` channel POSTs a *redacted, enumerated, capped* metadata field set (`kind`/`hostname`/`topic`/`session_hint`/`workflow_id`/`phase` — never title/body/message/next_action/transcript/raw text) to a **fixed SaaS host** (v1 Telegram), behind an **env / verified-ignored-local** opt-in with an **env-only** credential (a token alone never activates; tracked/repo config can never activate; HOME-is-repo inside-repo files fail-closed), over a **fully-pinned no-redirect** `fetch` (curl not registered; the one in-process fetch is registry/AST-scanned + permitted only in notify.mjs — the keystone gate lands before any fetch use), with a separate `buildEgressPayload` (enumerated-only, provably excludes event_id), egress-only **secret-scrub (scrub-before-cap)**, an attempt-**mirror** to file-log (`egress_channel`/`egress_status`, sanitized), and **claim-finalization** dedupe (a failed dispatch RELEASES the claim so a config fix re-fires; a repeated failure ENGAGES a fingerprint-keyed backoff throttle; a config fix BYPASSES it). One channel serves **both** hosts (Claude attention sensors + Codex `notify=` shuttle); `hostname` weaves into the `event_id` so all machines × all sessions fan into **one chat** while staying distinct. Owner-decision gate: **Accept** (bounded §4 amendment, not a general egress precedent) vs Forbid→Alt A; recurring multi-machine demand confirmed → accept live | Accepted |
| [0042](0042-designer-persona-design-ux-workbench.md) | `designer` persona (L3) — code-first design/UX decision & quality workbench: pre-code design (user flow / wireframe spec / CTA copy / IA) + **post-code quality critique loop** (heuristic/a11y/conversion/consistency lenses over screenshot vision + frontend code), 7-axis decision pool (`usability` common decisive + `accessibility` common veto encoded `role: supporting`+`gate: true`, ADR-0027 enum unchanged), 4 presets mapped by 5 L4 profiles (general+flow → balanced); **Figma excluded** (code-first, cross-host symmetric) / `image` L2 **composed not re-implemented** (ADR-0037); non-dispatch (founder precedent), copy-not-import machinery (ADR-0029); applies ADR-0010 §6 Trigger 3 + §7; drafted via `engineer:start` + Codex cross-host peer review (verdict=block, 10 findings applied); Accepted 2026-07-09 after the PR7 real-topic dogfood (7 defects found, 6 fixed, 1 recorded as demand-gated follow-up); cascades ADR-0010 §1 L4 (drops `image`/`print`/`brand`/`motion`/`frontend` from designer profiles) + §7 (third L3 occupant) | Accepted |
| [0043](0043-founder-designer-footer-enablement.md) | founder/designer workflow-projection + completion-footer enablement — the runtime-enablement ADR that ADR-0042 required and ADR-0039 §7 / ADR-0031 Amendment §Scope deferred to: `VALID_WORKFLOW_KINDS` widens to the four personas (unsupported-kind degradation path **stays**, regression re-pinned on a genuinely unknown kind + fixture-conversion sweep; `PLUGIN_COMMAND_RE` designer omission fixed on the same surface); founder/designer onboard by the ADR-0039 §7 recipe under the ADR-0031 Amendment's eight decisions with an **explicit behavioral baseline** (engineer's path-targeted projection + orchestrator's hardened delivery/stale-clear; `emitHandoff` opt-in; last-writer-wins slot accepted; orphan-sweep path honestly out of promise; copy-not-import per ADR-0010 §5); completion-flag mapping comes from the **S9 output contract**, not engineer's blocked-collapse; footer-rendered marker = **documented cross-package contract** (attention hardcodes filename+JSON gate); dual footer/notify discovery floors with capability-file parameterization, **footer floor = first released runtime version containing the enum expansion** (never pinned pre-release); rollout `(S2→release→install) ∥ S9 → S3∥S4 → install + Codex /hooks re-attestation`, S2 non-revertible after personas ship (personas-first rollback + one-shot artifact cleanup), per-package commits (ADR-0016); attention `SENSOR_PERSONAS` expansion deferred w/ trigger (S3/S4 released), dashboard designer Tier-1 inclusion and doctor ledger widening out of scope (orthogonal per-surface decisions — founder proves it) | Accepted |
| [0044](0044-session-generic-handoff-capture.md) | Session-generic handoff capture — code firing point for out-of-workflow session boundaries (honestly a **rolling turn-complete checkpoint**): two-tier trust split (guaranteed machine-derived structural floor with observer-labeled fields + opportunistic staged note whose provenance proves the **channel, not the author**); fired by attention's existing Claude `Stop` sensor **before and independent of** notification work (sensor relays observations, runtime publishes — push-not-pull preserved, runtime stays hook-free, Codex two-part invariant untouched; **widens ADR-0040 §3 attention charter** to "host-lifecycle sensors feeding allowlisted runtime executors"; **separate released-only publisher floor**, notify floor 0.71.0 untouched per ADR-0043 rule); gated by new `session_capture` config key default `off` via an **explicit narrow ADR-0035 §3 invariant-1 amendment scoped to `publish-session`** (ADR-0040's config-key shape was notify-scoped, so 0044 carries its own authorization + enumerated own-lock/temp deletion grant; ADR-0041-grade env-only gating rejected as disproportionate for non-network repo-local M1); **slot not ledger** under `state/runtime/session-capture/` — a **narrow ADR-0031 §6 second-artifact amendment** — with `entry.json` as **commit record** (per-file temp+rename, fingerprint-pair mismatch forces republish: mixed generations self-heal, never load-bearing), fingerprint no-op read from the committed entry (includes session_id + note hash), real `O_EXCL` mutex (claimDedupe = precedent not mechanism), and **evidence-not-suppression** (`repo_recent_terminal_evidence` recorded as arbitration data — projection has no session identity, so publisher-side in-workflow suppression is rejected as unsound); staged note = repo-global by design with staging git-context + content hash + 24h fold window + `--clear`, `--file` hardened (no-follow/regular-file/size cap) atop canonicalized write-root containment (lexical-only pointer checks insufficient for an automatic writer); sanitized `entry.json` projection (enumerated single-line clamped fields, `note_staged_at` not frozen age, **no imperative/next_action field** per SessionStart injection ruling, summary presented as untrusted quoted data) as ADR-0045's input contract — S5 owns exit-side production/lifecycle, S6 owns entry arbitration; **explicit v1 scope decision: Claude limb only** (no Codex firing point; shared-fs participation; ADR-0041 cited as shape not equivalence), PreCompact acknowledged as recorded host truth but rejected v1 on ≤1-turn marginal value, transcript mining rejected; hook-grade output discipline (exit 0/stdout-silent, diverging from operator subcommands), conditional-guarantee honesty (safe mode/floors surfaced via settings+doctor readiness diagnosis), durable advisory consumption (no delete-on-read; consumed-markers are ADR-0045-owned siblings), normative schemas/caps/TTLs in plugin-packaged content-token-enforced `session-capture-contract.md` (ADR-0046 vehicle), runtime-releases-first → attention-floor-pin rollout with consumer-first rollback + one-shot artifact cleanup; `context.mjs` gains `publish-session`+`note`+`status --slot` through the ADR-0035 §5 add-gate with mutation-verified hostile-path tests | Proposed |
| 0045 | Entry-time active proposal surfaces (file pending — reserved by macro `macro-plan-20260712T022752Z-d542f5` subtask S6) | Reserved |
| [0046](0046-machine-bootstrap.md) | Machine bootstrap — first-class `runtime:bootstrap` lifecycle command (subcommand nouns `plan\|status\|resume\|verify` + `profile export\|seed`), **not** a `runtime:settings` flag and **not** doc-only. Two-stage cold start: Stage 0 (host-native marketplace + runtime install) is document-only and **irreducible** — Claude's marketplace-add is not even in the H2 allowlist, and ADR-0006 already rejected a repo-level installer; Stage 1+ is a runtime-conducted **hybrid** interview (diagnose → profile-seeded default → ask → render fragment → **operator applies** → re-probe), ADR-0024 having already rejected doc-only as an end state. **Machine-scoped by construction** (repo-scoped catalog/source readers forbidden) — which is the fix for `runtime:settings` emitting sixteen false `Add <name> to marketplace.json` remediations and *silently* never recommending updates outside the source tree; the consumer-repo misbehavior is a **code defect in one branch** of `runtime:settings`, not a falsified ADR-0024 premise (ADR-0024 defines repo-local vs user-global paths generically) — repairing that branch is a prerequisite, pinned by its own regression. Authorizes one new **machine-global M1 artifact home** (`~/.agentic-plugins/runs/bootstrap/`, `~/.agentic-plugins/profiles/`) as an M1 *location* extension — no new tier, no network, and **no second executor** (H2 plugin-management stays behind `settings --execute-plugin-management`). Separating plan from execute does **not** by itself repair the executor-runs-before-artifact ordering — **write-ahead** does (persist planned intent + plan hash before any action), which narrowly supersedes `settings-report-contract.md`'s "re-run, not rollback" ordering for the plugin-management and cleanup executors. **Secrets-free portable machine profile** = an *untrusted source of interview defaults*, **never an input to any activation or config loader** (three guards: fail-closed secret scrub + boundary validator + static loader test) — generalizes the egress-launcher chat-id pre-fill from one value to the whole machine, credential stays env-only. Completion has two **terminal** states (`complete` requires the bounded cross-host `deep-peer-smoke` proof; otherwise `configured-not-verified`) plus the non-terminal `incomplete`; a one-host machine cannot reach `complete` and is told so rather than looped. ADR carries policy; the **plugin-packaged** `machine-bootstrap-contract.md` (content-token enforced à la `footer-contract.md`, **not** citation-only à la `settings-report-contract.md`) carries the schemas — because only the packaged doc is readable from a consumer machine (`compat.mjs` PLUGIN_ROOT precedent). Nine-axis decide + independent Codex Brainstorm converged (`agreed`, aggregate 2.56/1.56/0.89, sensitivity `flipped: false`); a Codex Plan-verify pass then returned 7 blockers + 12 factual errors against the first draft, all folded in (machine-probe seam, marketplace probe, plugin-set/version policy, planner purity, **write-ahead** durability, declinable set, proof transport) | Proposed |
