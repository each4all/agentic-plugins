# ADR-0048: Bootstrap observability — statusline stage, shipped-component policy, egress evidence vocabulary, credential boundary

## Status

Accepted (2026-07-23)

<!--
This ADR sits inside the ADR-0024 runtime/operator control-plane track and is
the decision gate of the bootstrap/statusline/observability macro
(macro-plan-20260722T131932Z-73ff87). It composes — and narrowly amends where
stated — ADR-0040 (operator observability; Tier 4 partial supersedure),
ADR-0041 (egress; §6 statusline wording), and ADR-0046 (machine bootstrap;
§7 profile content + Stage 5 scope). Schema/contract/code realization is owned
by the macro's implementation subtasks (bootstrap-contract-vnext and the three
leaves); this ADR carries policy and vocabulary only.
-->

## Context

- The macro's Plan-verify peer pass (Codex, REVISE) required the statusline
  stage placement, the shipped-component policy, the proof vocabulary, and the
  credential boundary to be settled **by ADR** before any implementation
  subtask runs, and retired "agent enters the token on the operator's behalf"
  from the plan.
- Host truth is pre-recorded in
  [`docs/assurance/statusline-host-truth-2026-07-22.md`](../assurance/statusline-host-truth-2026-07-22.md):
  Codex CLI has a native statusline — `[tui].status_line`, an **ordered list
  over a closed item vocabulary** (since openai/codex#10546, announced in
  rust-v0.99.0; custom external statusline commands are an explicit upstream
  non-goal) — while Claude Code's `statusLine` is a **shell command** (script
  path or inline; Windows Git Bash-first, PowerShell fallback) whose execution
  is gated by workspace trust, `disableAllHooks`, and `CLAUDE_CODE_SAFE_MODE`:
  **configured is not active**. `docs/ARCHITECTURE.md` still said "Codex has
  no equivalent"; this ADR ships the correction.
- ADR-0040 §6 deferred "Tier 4 (Claude statusline adapter)" with the recorded
  evidence that `statusLine` is not plugin-bundlable and a future Tier 4 is an
  M1 settings-fragment plan. ADR-0041 §6 stated "runtime ships no statusline
  component". ADR-0046 fixed the bootstrap stage model (Stage 5 =
  notification + egress; Stage 6 = permission posture) and the secrets-free
  profile (§7).
- Run schema 1.1 requires `directions` on **every** proof
  (`runtime-bootstrap-run-1.1.json` — per-direction result map), and the
  zero-dependency validator deliberately excludes `oneOf`/`anyOf`/`if-then`
  (`schema-validate.mjs`), so egress evidence needs an explicit kind
  discriminator, not a declarative union.
- Decision method: nine-axis `--size=major` comparison + independent Codex
  Brainstorm ensemble (verdict **agreed**; weighted aggregates D1 2.67/1.22/1.33,
  D2 1.78/1.44/2.78, D3 2.78/1.89/1.56, D4 2.78/1.67; sensitivity
  `flipped: false` on all four). The owner approved all four recommendations
  in-session on 2026-07-23 and directed one item-set adjustment (§2.1).

## Decision

### 1. Stage placement — Stage 5 becomes "operator observability + egress"

Statusline configuration joins **Stage 5** of the ADR-0046 stage model; the
stage is explicitly **renamed** from "notification + egress" to "operator
observability + egress" so it does not read as a miscellaneous bucket. No
stage is inserted and nothing is renumbered.

- Two **per-host, declinable** expected steps:
  `statusline.claude.configured` and `statusline.codex.configured` (mirroring
  the `permission.<host>.applied` split — a single combined step could
  false-pass after only one host is configured).
- The Claude step's meaning is pinned to **"canonical configuration
  observed"** — never "statusline runs". Workspace trust, `disableAllHooks`,
  safe mode, and script failure can still block execution (host-truth record
  §3), and no probe or fragment may relax those gates.
- Open 1.1 runs migrate **additively** (the new steps are injected and
  `resume` re-renders the new fragments, or the operator abandons and starts
  a 1.2 run — realization owned by the bootstrap-contract-vnext subtask).
  Terminal 1.1 runs remain **immutable historical evidence**; they are never
  re-certified against the 1.2 registry.
- The `docs/ARCHITECTURE.md` host-neutral/host-specific table row and the
  "honest scope" example are corrected in this ADR's change set, citing the
  host-truth record.

### 2. Shipped-component policy — native-first with a bounded, credential-free shim

ADR-0041 §6's "runtime ships no statusline component" is **amended** to:

> runtime ships no **automatically installed** statusline component; runtime
> MAY **render** a credential-free Claude statusline shim as an artifact for
> **explicit operator installation**.

- **Codex**: always the native ordered-array fragment for
  `[tui].status_line` — nothing is shipped; the closed upstream vocabulary is
  the renderer.
- **Claude**: an **inline-sufficiency gate** decides the fragment shape. The
  inline `statusLine.command` form is used only when ALL hold:
  1. bounded projection of host-provided stdin JSON only;
  2. no filesystem or plugin-state lookup;
  3. identical tested behavior under Git Bash and PowerShell;
  4. short enough to review as one exact command;
  5. no chaining of any pre-existing/unknown command.
  When the gate fails (the adopted 6-item preset in §2.1 is expected to fail
  it), runtime renders a **shim** — read-only, bounded, credential-free,
  network-free, non-polling, order-preserving under missing data — as an
  artifact the operator installs (conventional home
  `~/.agentic-plugins/bin/`); runtime never writes it there itself.
- The inline renderer and the shim MUST consume **one canonical ordered
  policy definition** (single source; drift between the two renderers is the
  named failure mode).
- A pre-existing `statusLine` value in the operator's settings is classified
  `already-configured | replace | manual-merge | decline` — never
  auto-chained.

#### 2.1 Adopted statusline item set (owner decision)

Fixed order, both hosts, **six items**:

```
model-with-reasoning · git-branch · pull-request-number ·
context-used · five-hour-limit · weekly-limit
```

Version items (`codex-version`; the Claude `version` stdin field) are
**excluded by owner direction (2026-07-23)**. Codex renders the set natively;
the Claude shim renders the same six logical items from its stdin JSON
(`model.display_name`+`effort.level`, git branch, `pr.number`,
`context_window.used_percentage`, `rate_limits.five_hour.used_percentage`,
`rate_limits.seven_day.used_percentage`). The preset is carried in the
portable machine profile as a **scalar preset id** (profile 1.1-additive;
a nested/custom item shape would be a major profile-schema bump — ADR-0046
§7 amendment below).

### 3. Egress evidence vocabulary — machine proof vs owner attestation

Run schema 1.2 (realized by bootstrap-contract-vnext) separates machine
evidence from human testimony **at the vocabulary level**:

- **Step / proof kind**: `proof.egress-provider-ack` / `egress-provider-ack`,
  with kind-specific evidence member `provider_ack`. It proves exactly that
  the pinned provider request returned HTTP 2xx + `{ok:true}` — it is
  deliberately **not** named "dispatch" or "delivery".
- **Kind-discriminated fail-closed validation** (no `oneOf`): directional
  kinds require `directions` and forbid `provider_ack`;
  `egress-provider-ack` requires `provider_ack` and forbids `directions`;
  unknown kind, both members, neither member, duplicate kind, or
  filename/kind mismatch is rejected; stored aggregates are recomputed,
  never trusted.
- **Owner attestation**: `completion.egress_receipt_attestation` records the
  owner's claim that the message appeared on their phone. Verb is
  `attested`, never `passed`; required shape: `surface: "owner-phone"`,
  `attested_at`, the same synthetic attempt hash, and a linked
  provider-proof artifact hash; no free-text note, no device identifier.
- **Presentation**: current provider proof + linked attestation derives the
  label **`delivery-attested`**. The generic bootstrap `complete` state is
  unchanged — receipt never silently redefines it.
- **Freshness binding**: bound versions alone are insufficient — the proof
  binds runtime/contract versions **plus** the sanitized activation
  fingerprint, the synthetic attempt hash, and the artifact hash, so a
  changed channel/recipient/credential invalidates staleness honestly.
  Nothing token-, recipient-, URL-, body-, raw-response-, or
  `message_id`-shaped is persisted.
- **Companion defect repairs** (in-scope for vnext because the vocabulary is
  only as strong as its enforcement): `writeBootstrapProof()` validation
  becomes mandatory (not an optional injected argument); every manifest read
  boundary validates before selection/reduction; the reducer's last-wins
  duplicate handling becomes duplicate **rejection**; the answers grammar
  gains an explicit attestation-recording action (audit-logged).

### 4. Credential boundary — component-scoped, env-only, honest

The absolute claim "tools and agents never see the token" is **refuted as
written** — the E1 activation checker reads the value for presence/collision
(`egress-config.mjs`), the pinned emitter consumes it (`notify.mjs`), and
doctor deliberately preserves the raw environment for explicitly-executed
peer proofs whose attention hooks must egress (`doctor.mjs`). ADR-0048
therefore states the boundary the implementation can actually enforce:

> The operator provisions `TELEGRAM_BOT_TOKEN` directly in an
> operator-controlled local shell. Runtime never asks for or accepts the
> value through chat, prompts, answer files, CLI argv, stdin, host
> configuration, profiles, rendered fragments, or artifacts. Only the named
> E1 activation checker may inspect the value for presence/collision, and
> only the pinned E1 emitter may consume it to validate and issue the
> provider request. The value is never returned, logged, mirrored,
> persisted, or supplied to the model. Unrelated and control-plane child
> environments are scrubbed at the point of spawn; the explicitly-executed
> proof path's environment inheritance is a **documented exception**, not a
> loophole. This is a **data-flow and persistence boundary, not process
> isolation**: a host or peer session launched with the credential in its
> ambient environment technically possesses that capability.

Enforcement (realized across the implementation subtasks):

- a **static named-reader allowlist test** for modules permitted to read the
  credential key;
- the profile's `credential_env_var` becomes a **schema constant**
  (`TELEGRAM_BOT_TOKEN`) — the current schema accepts arbitrary strings;
- secret scrub before every profile, proof, attestation, statusline, and
  bootstrap write; fake-token scans across argv, stdout/stderr, filenames,
  artifacts, state, and child environments continue;
- statusline inline commands and shims MUST NOT read the credential
  variable;
- the bootstrap egress stage renders **placeholder commands/procedures
  only** — the operator exports the real value in their own shell;
- token-alone-inert stands: activation and recipient remain separate
  operator-controlled inputs (ADR-0041 §2c unchanged).

## Consequences

**Positive**

- Operator observability becomes a first-class bootstrap stage with honest
  per-host semantics ("configuration observed", never "execution proven"),
  and the `ARCHITECTURE.md` statusline contradiction is corrected with a
  cited host-truth record.
- The egress evidence vocabulary makes machine proof and human testimony
  epistemically distinct and reusable for future non-directional proof
  kinds; three latent enforcement defects (optional proof validation,
  unvalidated read boundaries, last-wins duplicates) get fixed as part of
  realizing it.
- The credential boundary is stated as a guarantee the code actually
  enforces, with the inheritance exception documented instead of hidden.
- Unblocks the macro chain: egress-portability → bootstrap-contract-vnext →
  {notify-axis, statusline-adapter, egress-proof-executor} → integration →
  release-dogfood.

**Negative**

- Stage 5 broadens (mitigated by the explicit rename and per-host step
  split).
- Claude statusline needs two tested render modes (inline + shim) plus the
  sufficiency gate; the single-policy-definition rule adds a small amount of
  structure to keep them from drifting.
- A new attestation-recording action must be added to the answers grammar
  (the current vocabulary has no receipt verb).

**Neutral**

- All schema/contract/code changes (run 1.2, step registry, validators,
  fragments, shim, proofs) are owned by the macro's implementation subtasks;
  this ADR is their normative reference.
- The macro plan's earlier "7-item" statusline wording is superseded by
  §2.1's owner-directed 6-item set.

## Alternatives Considered

- **D1 — extend Stage 6 (permission posture)**: groups by destination file
  rather than responsibility; makes observability look subordinate to
  permission policy and invites false coupling to `proof.permission`.
  Rejected (aggregate 1.22 vs 2.67).
- **D1 — insert a dedicated statusline stage**: renumbers stages 6-8,
  propagating through `CONFIG_STAGES`/`PROOF_STAGES`, the schema stage enum,
  the reducer, CLI rendering, and tests, and forces a write-capable open-run
  migration — all to solve categorization, not operator awareness. Rejected
  (1.33); revisit only if ambient observability grows multiple independent
  families with distinct ordering/proof dependencies.
- **D2 — fragment-only (no shim ever)**: hides substantial parsing/color
  logic inside a settings-string one-liner for the 6-item preset; brittle
  across Git Bash/PowerShell quoting. Rejected (1.78) — inline remains valid
  below the sufficiency gate.
- **D2 — runtime-managed installed script**: creates an M1
  executable-materialization domain (install/update/hash/rollback/inventory)
  that ADR-0046's enumerated layout never authorized, for a single-host
  display adapter. Rejected (1.44).
- **D3 — implement `oneOf` in the local validator**: a half-correct
  combinator silently admits invalid evidence; a security-sensitive
  validator subsystem is disproportionate to one non-directional kind.
  Rejected (1.89).
- **D3 — bespoke top-level egress fields**: precedent exists
  (`hook_attestation`) but every future non-directional proof becomes
  another special reducer path; fragments completion logic. Rejected (1.56).
- **D4 — keep the literal "tools/agents never see it" wording**: contradicted
  by the verified reader/emitter/inheritance code paths — a false guarantee
  in an ADR is worse than a narrower true one. Rejected.
- **D4 — out-of-band one-shot proof ceremony**: isolates only the bootstrap
  proof while ordinary hook-triggered egress still inherits the environment;
  adds a nonce/import trust boundary and per-machine operator burden.
  Rejected (1.67). If process-level agent blindness ever becomes
  non-negotiable, that requirement is **blocked** on a separate
  credential-broker architecture conflicting with the current no-daemon,
  in-process E1 design — record it as such rather than pretending this ADR
  achieves it.
