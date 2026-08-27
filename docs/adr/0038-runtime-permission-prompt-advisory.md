# ADR-0038: Runtime permission-prompt reduction advisory

## Status

Accepted (2026-06-27, PR #449). **Proposed to be superseded** by
[ADR-0057](0057-permission-advisor-removal.md) (proposed 2026-08-27); this line
becomes `Superseded by ADR-0057` in the same commit that flips ADR-0057 to
Accepted. **§6 is NOT superseded and remains in force**: the refusal to ship a
permission-relaxing Guard Hook, classified by *effect* rather than by who flips
the final switch, is a boundary decision about ADR-0035 §4 and is independent of
whether an advisory exists. ADR-0057 §Decision 8 carries it forward verbatim.
What ADR-0057 removes is the A+C advisory of §1/§2 — the diagnosis, the plan, and
the usage learner — whose §Context premise (allowlist catch-up) the host's `auto`
mode ended.

<!--
Relates to ADR-0024 (runtime operator control plane) and ADR-0035
(active-execution boundary policy). The A/C core sits inside ADR-0035's
existing R0/M1 tiers and adds no new mutation domain, so it does **not**
modify ADR-0035. A runtime-shipped Guard Hook (option B) would relax
permission policy, which ADR-0035 §4 forbids "independent of any flag";
this ADR therefore does **not** adopt B and does not reinterpret §4. Any
future Guard Hook requires its own ADR that amends ADR-0035 §4 by
effect-based classification. (An adversarial cross-host review of an
earlier draft flagged that treating B as a mere §4 "clarification" was a
loophole; this ADR records the corrected scope.)
-->

## Context

Both supported hosts interrupt work with permission prompts —
`Do you want to proceed?` in Claude Code, the analogous approval request
in Codex CLI. The user wants these to stop appearing during normal work,
and wants agentic-plugins to **provide a capability** that reduces them
(not merely fix this one repo's developer experience).

**Root cause — allowlist catch-up.** Claude Code prompts whenever a Bash
command is not on the settings allowlist, or on any file modification
(Edit/Write), WebFetch to an un-allowed domain, or an un-allowed MCP
tool. The allowlist is *reactive*: each new command shape prompts once,
the user adds an `allow` rule (often via the prompt's "don't ask again"
option, which appends `Bash(<cmd> *)` to a settings file), and the next
new shape prompts again. This repo's own `.claude/settings.local.json`
has accreted **417 lines** of allow rules and still prompts — evidence
that reactive accumulation never converges. The structural cures are
(a) broad *proactive* `allow` patterns, or (b) a hook that decides
dynamically; (a) is less dynamic but is itself a structural fix, not a
mere band-aid.

**The two hosts have different permission models** (researched for this
ADR against the current host docs, 2026-06):

- **Claude Code** — `permissions` in `settings.json` with `allow` /
  `ask` / `deny` (priority `deny` > `ask` > `allow`); permission modes
  (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`,
  `bypassPermissions`); and `PreToolUse` hooks that can return
  `permissionDecision` of `allow` / `deny` / `ask`. Protected paths
  (`.git/`, `.claude/`, …) are never auto-approved regardless of mode.
- **Codex CLI** — a product of two orthogonal axes: `sandbox_mode`
  (`read-only` / `workspace-write` / `danger-full-access`) and
  `approval_policy` (`untrusted` / `on-request` / `never`; `on-failure`
  deprecated). Set in `~/.codex/config.toml` (or a `--profile` overlay),
  with first-use **project trust**, `execpolicy .rules`, and granular
  per-category approval as finer allowlists.

**Companions already do not prompt.** `companions/codex-companion.mjs`
calls `codex exec --skip-git-repo-check --ephemeral` with **no**
`--sandbox` / `--ask-for-approval` / bypass flags, so it inherits
`codex exec`'s defaults (read-only sandbox + `never` approval): blocked
work fails rather than prompting. The prompts the user actually hits come
from **Claude Code sessions** and **direct interactive Codex use**, not
from the companion path.

**The binding constraint.** ADR-0035 §4 forbids runtime from *"relax or
bypass sandbox, network, approval, or permission policy"* **independent
of any flag**, and from writing host config automatically; ADR-0024 §4
says `settings` writes only agentic-plugins-owned config and "must not
silently relax sandbox / permission boundaries." So agentic-plugins
**cannot** turn the prompts off on the user's behalf, nor ship the
mechanism that does. That is not a limitation to route around — it is the
property that makes runtime a trustworthy L1 primitive. The principled
capability is therefore not *"disable prompts"* but *"diagnose what is
prompting, generate a recommended configuration with evidence, and let
the user apply it."*

Four delivery architectures were compared across the project's
multi-axis lens (standard / recommended / canonical / essential /
fundamental / extensible / maintainable / advanceable / practical, plus
ADR-0035 ceiling-compatibility and cross-host symmetry):

- **A. Advisor** — runtime diagnoses prompt-causing patterns and emits a
  recommended host configuration as a dry-run plan; the user applies it.
- **B. Guard Hook** — agentic-plugins ships a `PreToolUse` policy
  component that decides allow/deny/ask at runtime. It is the most
  *dynamic* cure for catch-up, but a component that returns `allow`
  **relaxes permission policy** — exactly what ADR-0035 §4 forbids
  "independent of any flag" — and it is cross-host asymmetric (Claude
  hooks have no Codex permission-decision equivalent).
- **C. Usage-Learner** — analyze usage records to ground A's
  recommendations in actual prompt events (Claude already ships a
  built-in `fewer-permission-prompts`; agentic-plugins' value-add is the
  cross-host, Codex-inclusive integration).
- **D. Recipe** — documentation/templates only; weakest against the
  "provide a capability" goal.

A fifth option — writing the recommended permissions into
agentic-plugins-owned `.agentic-plugins/config.toml` for "automatic"
application — is **technically impossible**: permissions live only in
host config, which the hosts read and agentic-plugins-owned files are
not. Writing host config to make it "automatic" crosses the §4 ceiling.

The maintainer chose **A + C as the canonical, shippable capability**,
Claude-first but both hosts first-class in design. **B is explicitly out
of scope of this ADR** and deferred to a separate, effect-based ADR (see
Decision §6) — *not* carried as an opt-in inside this one — because
shipping a permission-relaxing component is a head-on change to ADR-0035
§4, not a clarification an advisory ADR can absorb. This ADR records that
decision.

## Decision

### 1. Advisor role (the A core)

`plugins/runtime` gains a **permission advisor** role, split across its
two existing operator surfaces:

- **`runtime:doctor`** reports, **read-only (R0)**, which tool calls in
  the current environment are causing permission prompts and why —
  classified by host and by mechanism (Bash-not-allowlisted, file
  modification, WebFetch domain, MCP, Codex sandbox-blocked, Codex
  approval-requested). It mutates nothing.
- **`runtime:settings`** emits, as a **dry-run plan (M1, plan default)**,
  a recommended host configuration for each host:
  - **Claude**: an `allow` / `deny` block and a `defaultMode`
    recommendation (e.g., `acceptEdits` to clear file-modification
    prompts), expressed as the exact `settings.json` fragment to apply.
  - **Codex**: a recommended `approval_policy` / `sandbox_mode`
    (and, where appropriate, a named `--profile` overlay and/or a
    `[projects."<path>"] trust_level` entry), expressed as the exact
    `~/.codex/config.toml` fragment.

The recommendation is **safety-graded**: broad `allow` for known-safe
command families, explicit `deny`/`ask` retained for dangerous
categories (`rm -rf`, `--force`, `curl | bash`, secret/`.git` writes).
The plan never recommends `bypassPermissions` or `danger-full-access` as
a default; those appear only as an explicitly-labeled
"isolated-environment-only" note.

### 2. Usage-grounded recommendations (the C engine)

The advisor's recommendations MUST be **grounded in evidence**, not
guessed. `runtime` analyzes available usage records (transcript / session
logs) to find the commands and tools that actually triggered prompts, and
attaches that evidence to each recommended rule ("seen N times"). On
Claude this complements the host-native `fewer-permission-prompts` skill
rather than replacing it; the agentic-plugins value-add is extending the
same evidence-to-allowlist flow to **Codex** and presenting both hosts in
one cross-host plan. Where no usage record is available, the advisor
falls back to a conservative known-safe baseline and labels it as such.

### 3. Application stays with the user (boundary preserved)

Runtime **emits** the plan; it does **not** write host config. The §4
ceiling and ADR-0024 §4 stand unchanged: no automatic write to
`.claude/settings.json` or `~/.codex/config.toml`, no automatic
relaxation of any sandbox/approval/permission policy. Application is an
explicit user action (copy the fragment, or run the host-native command
the plan prints). This keeps the entire A/C core inside the **R0**
(doctor diagnosis) and **M1** (settings plan = agentic-plugins-owned
artifact) tiers of ADR-0035 — it adds **no new mutation domain**.

### 4. Cross-host scope — both first-class, Claude-first implementation

The design treats Claude and Codex as **first-class** (per ADR-0001
cross-host parity). For the A/C core the symmetry is real: both hosts get
a plan from the same evidence-to-recommendation flow. Implementation is
**Claude-first** for practical reasons: Claude prompts are more frequent
(the 417-line allowlist), and the Codex companion path already does not
prompt. The first slice ships the Claude advisor; the Codex advisor
(approval_policy / sandbox_mode / profile / project-trust plan) follows
immediately after. Where a host lacks an equivalent mechanism, the limit
is documented honestly (ADR-0001 §5) rather than faked — the sharpest
such asymmetry, the Guard Hook, is the reason B is deferred (§6).

### 5. Usage-record privacy and artifact sanitization

The C engine reads usage records (transcripts / session logs) that can
contain secrets, tokens, local paths, repo content, or private URLs.
Carrying ADR-0035 §3/§6 (sanitized artifacts; no secrets, raw stdout, or
source-path dumps in the session) forward, the advisor MUST:

- Extract only **command/tool patterns** and prompt-cause categories, not
  raw command bodies — the recommended rule is the generalized pattern
  (e.g., `Bash(npm run *)`) and the evidence is a count ("seen N times"),
  never the verbatim argument string.
- Redact secret-shaped tokens (keys, bearer tokens, passwords, credential
  URLs) from any retained artifact, and never inline raw transcript
  content into the main session.
- Write plan and evidence only to agentic-plugins-owned
  `.agentic-plugins/**` artifacts under the existing retention policy,
  surfacing pointer/sanitized output in the session (ADR-0035 invariant
  6).

### 6. Guard Hook (B) is out of scope — deferred to a separate, effect-based ADR

A `PreToolUse` policy component that returns allow/deny/ask is the most
*dynamic* cure for allowlist catch-up, but a component that returns
`allow` **relaxes permission policy**. ADR-0035 §4 forbids runtime from
"relax or bypass … permission policy" **independent of any flag**, and
ADR-0035 §2 classifies by **mutation domain**, not by who flips the final
switch. A runtime-shipped hook that produces the forbidden outcome is in
the permission-relaxation domain whether or not the consumer enables it —
shipping the mechanism is the relevant act. Consumer opt-in relocates the
final step; it does not neutralize the ceiling.

Therefore this ADR does **not** adopt B and does **not** reinterpret §4.
B may be revisited only by a **separate ADR** that:

1. **Amends ADR-0035 §4 head-on**, deciding by *effect* whether
   agentic-plugins may ship a permission-relaxing component at all, and
   under what exact boundary — not as a "clarification."
2. Classifies the hook in a **named permission-relaxation domain/tier**
   (ADR-0035 defines none today; the amendment adds one or forbids it).
3. Treats the **cross-host asymmetry as a first-order cost**: Claude has
   a `PreToolUse` permission-decision hook; Codex `execpolicy` / granular
   approval is **not** equivalent if it cannot decide dynamically per
   tool call. B is Claude-only until Codex gains an equivalent.
4. If allowed, pins hard conditions: exact approved tool types; **never**
   approve protected paths; no broad write / network / MCP approval
   without separate review; a **versioned, inspectable** policy table;
   visible update diffs; tests proving deny/ask fall-through; and an
   explicit disable / uninstall path.

Until such an ADR exists, **A + C is the entire shipped capability.**

### 7. Tier classification and enforcement

- `runtime:doctor` permission diagnosis → **R0** (read-only).
- `runtime:settings` permission plan + sanitized evidence artifact →
  **M1** (agentic-plugins-owned writes only; no host config).
- A Guard Hook is deliberately **not** slotted into a tier here: by
  effect it belongs to a permission-relaxation domain ADR-0035 does not
  currently define, which is exactly why §6 defers it to an amending ADR
  rather than forcing it into an existing tier.

No surface in the A/C core writes host config, so none reaches H2/H3.
The ADR-0035 registry + static-test guard, when built, covers these
surfaces unchanged (they introduce no new child-process / `fs` / network
primitive beyond read-only diagnosis and owned-artifact writes).

## Consequences

**Positive**: Permission-prompt fatigue gets a principled, evidence-based
remedy that stays entirely inside ADR-0035's R0/M1 tiers — zero
modification to the boundary policy, zero new mutation domain. The
advisor is a natural extension of runtime's existing "dry-run planner"
identity, so it carries near-zero architectural risk. Usage-record
privacy is pinned up front. The Guard Hook's genuine tension with §4 is
named honestly and routed to a head-on amendment instead of being
smuggled in as a clarification.

**Negative**: The A/C core reduces prompts but does not *eliminate* the
catch-up problem — the user still applies the plan, and genuinely new
command shapes can still prompt until the next advisor run. The most
dynamic cure (B) is deferred and, when revisited, is Claude-asymmetric
and gated behind a boundary-policy amendment. Usage-record analysis must
handle two different transcript formats, absent-record fallback, and
redaction.

**Neutral**: No host-facing behavior changes on merge — this ADR
authorizes the A/C surfaces, it does not ship them, and it leaves
ADR-0035 untouched. Runtime stays read-only by default; B stays out of
scope.

## Alternatives Considered

- **Ship B as a default-off opt-in inside this ADR (the earlier draft).**
  Rejected. A shipped hook that returns `allow` relaxes permission
  policy, which ADR-0035 §4 forbids "independent of any flag." Framing it
  as a §4 "clarification" because the consumer flips the final switch is
  classification by ownership, not by effect — a loophole flagged by
  adversarial cross-host review. If agentic-plugins is to ship
  permission-relaxing components at all, that must be decided head-on in
  an ADR that amends §4 by effect (Decision §6), not absorbed into an
  advisory ADR.

- **Write recommended permissions into agentic-plugins-owned config for
  automatic application.** Rejected as *technically impossible*:
  permissions are read only from host config (`.claude/settings.json`,
  `~/.codex/config.toml`), which an agentic-plugins-owned
  `.agentic-plugins/config.toml` cannot stand in for. Writing host config
  to make it "automatic" crosses the §4 ceiling.

- **Recommend `bypassPermissions` / `danger-full-access` as the
  default.** Rejected: it eliminates prompts by eliminating the safety
  surface entirely, is appropriate only inside an externally-isolated
  container, and contradicts the safety-graded recommendation principle.
  It survives only as an explicitly-labeled isolated-environment note.

- **Documentation/templates only (D).** Rejected as the *capability*:
  the user explicitly wants agentic-plugins to *provide a function*, not
  a setup guide. A recommended-configuration document is a fine
  by-product of the advisor but is not, by itself, the deliverable.

- **A new dedicated plugin for permission management.** Rejected: host
  readiness and operator configuration are exactly `plugins/runtime`'s
  charter (ADR-0024). A separate plugin would duplicate runtime's
  host-truth and settings machinery and fragment the operator surface.
