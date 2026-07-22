# ADR-0041: Cross-machine notification egress

## Status

Accepted (2026-07-06)

*Amended 2026-07-07 ([decide-headline] / macro `…85bdad`, subtask `adr-amend`):
§3a adds the opt-in, closed-vocabulary `headline` status token as a
**DECIDED-but-not-yet-shipped** payload field **within** the existing E1 tier (a
payload refinement, **not** a new effect domain — no ADR-0035 §4 ceiling change).
See the §3a Status blockquote: `headline` is the design of record, not a shipped
capability, until `release-dogfood` proves real delivery.*

*Amended 2026-07-07 ([egress-launcher]): §12 adds the first-class, artifact-only
**egress launcher** (`runtime:settings --egress-launcher-plan`) that realizes the
prototype-cutover track (§2d Status / §11). A **planner** — it writes no
activation and emits no network effect — so it is strictly below the E1 ceiling
and needs no ADR-0035 §4 change.*

<!--
Amends ADR-0035 §4 head-on (effect-based classification) to add one new,
narrowly-scoped effect domain. On acceptance: (1) record "§4 amended by ADR-0041"
in ADR-0035's Status/§4, and (2) update ADR-0040 §2's deferred-channel text to
point here. Relates to ADR-0040 (the pipeline it extends) and ADR-0038 (§6
amendment shape + effect-not-ownership). Hardened by two Codex ensembles:
Plan-verify (plan-verify-20260705T034531Z-a56cf34: CRIT config-egress + MAJOR
redirect/scanner/fire-forget/overclaim/schema + CONFLICT init-cred/ownership) and
Review (review-20260705T040229Z-f79b813: MAJOR activation-proof/egress-payload-
separation/dedupe-failure + owner-gate/service-admission). All folded in below.
-->

## Context

ADR-0040 shipped the operator-observability notification pipeline: attention
sensors build bounded events, the runtime `notify.mjs` emitter runs a fixed
pipeline (validate → dedupe → quiet-hours → redact → dispatch), and dispatch
targets a **built-in allowlist channel**. All three shipped channels are
**local sinks**: `none`, `macos-osascript`, `file-log`. ADR-0040's "cross-host"
means **two AI CLI hosts (Claude Code vs Codex CLI) on one machine** — never
another **physical machine**.

**The real demand.** Operators run Claude Code across **multiple machines over
ssh+tmux** and want every attention moment — approval-needed, your-turn,
complete — from **all machines and all sessions** delivered to **one device** (a
Telegram chat). A working prototype exists as a per-machine personal hook
(`~/.claude/telegram-notify.mjs` + `settings.json` hooks calling `curl`) but
lives **outside the agentic-plugins pipeline**: project tools cannot see it, each
machine needs manual setup, and it has no test/boundary coverage. Make it a
**first-class capability** so install/update + a one-time per-machine credential
is all it takes. This is **recurring multi-machine demand**, not a one-off.

**The binding constraint — ADR-0035 §4.** The active-execution boundary's
permanent ceiling forbids (independent of any flag) "arbitrary/user-supplied
argv", "mutating auth/token/secret state", and "relaxing/bypassing sandbox,
network, approval, or permission policy". The executor registry
(`ALLOWED_COMMAND_LITERALS = [claude, codex, git, /usr/bin/osascript]`) has **no
`curl`**; the network gate allows only `compat.mjs`'s **inbound, GET-only**
fetch. An **outbound POST egressing session-derived data to a third party** is a
new effect domain. ADR-0040 §2 pre-classified it: a config-sourced-argv channel
is "explicitly deferred", needing "a future ADR that amends §4 head-on and
decides by effect whether agentic-plugins may ship it at all — the outcome may be
forbid." ADR-0038 §6 fixed the doctrine: **classification is by effect, not
ownership** — "consumer opt-in relocates the final step; it does not neutralize
the ceiling." Init-time configuration does not move egress across the line, and
ownership of the metadata is not a safety term — only an enumerated, capped,
redacted field set is.

**Scope-shaping findings** (3-agent investigation + two Codex ensembles):

- `transcript_path` is already on every Claude hook payload (the Stop sensor
  ignores it) — but transcript content is **excluded from egress** (below).
- Redaction is **allowlist + cap + control-strip + injection-safe**, with **no
  secret-scrub** — free text (a transcript tail, or a free-form `next_action`)
  can carry keys/tokens that would leave the machine on egress.
- `.agentic-plugins/config.toml` is **tracked**; the settings planner echoes
  notify-key values into artifacts; only `*.local.toml` is gitignored. Channel/
  recipient/token from tracked config is a **repo-controlled egress-activation
  vector**. Egress activation, recipient, and secret must come from the operator
  environment or a **fail-closed-verified** ignored-local layer — never tracked
  config, and a token alone must never activate egress.
- `fetch` follows redirects by default — host-pinning is **not** egress-bounding.
- A `notify.mjs` channel is reachable from **both** the Claude attention sensors
  and the Codex `notify=` shuttle — one channel serves both hosts.

## Decision

Adopt a **narrowly-scoped, effect-amended egress channel** (option B). This ADR
**amends ADR-0035 §4 head-on** to add exactly one new, named effect domain —
`E1 — enumerated-metadata network egress` — authorizing exactly the shape below.

### 1. New boundary tier: `E1 — enumerated-metadata network egress`

Outbound network delivery of a **redacted, enumerated, capped set of metadata
fields** to a **fixed allowlist of SaaS notification services**, behind an
**env/verified-ignored-local opt-in**, using an **env-only credential**, over a
**fully-pinned, non-redirecting request**. Everything outside this exact shape
remains forbidden. The safety argument rests on the *enumerated field set +
pinned request + mechanically-verified local activation* — never on "ownership"
of the data.

### 2. Hard conditions (all mandatory; failing any = not this tier)

- **(a) Service allowlist, not arbitrary webhook.** Destination is a
  **project-fixed SaaS host** (v1: Telegram). The user supplies a **credential**,
  never a URL. Arbitrary/self-host URLs are **rejected** (network form of
  "user-supplied argv"). New services join only via §9's admission checklist +
  a service-specific ADR.
- **(b) Fully-pinned request, no redirect.** Pinned:
  `POST https://api.telegram.org/bot<TOKEN>/sendMessage`, JSON body with a fixed
  key set, `redirect: "error"`, TLS only. Token/chat-id are **shape-validated**;
  path components encoded; body size capped. A unit test asserts the captured URL
  + options — using a **fake token only**; no real or token-shaped value is ever
  logged, mirrored, or written to an artifact.
- **(c) Env credential + mechanically-verified activation.** The token comes
  only from `TELEGRAM_BOT_TOKEN` (env; the **operator's shell**, not the repo).
  **Egress activation (`notify_channel="telegram"`) and recipient (chat-id) never
  come from tracked config.** Because ADR-0040's current loader resolves
  `notify_channel` from **repo config before user config** — and intentionally
  lets repo config activate the *local* channels (`file-log`/`macos-osascript`) —
  E1 MUST NOT ride that same enum path. Egress activation goes through a
  **separate E1 activation loader / explicit egress-override rule** that reads
  activation + recipient **only** from env or a verified-ignored-local layer, so
  merely adding `telegram` to the channel enum can **never** let tracked
  `.agentic-plugins/config.toml` activate egress. Any local file honored for this
  (user-home `~/.agentic-plugins/*.local.toml` **or** repo-local) MUST be
  **fail-closed-verified** as untracked, a regular non-symlink file, and
  operator-owned before use. **A token alone never activates egress**: activation
  is a separate, explicit, non-tracked setting. Missing either credential or
  activation = silent no-op.
- **(d) In-process HTTPS request (`node:https`), explicitly authorized — not `curl`.**
  Registered in the executor guard as a **network `CAPABILITY_IMPORTER` for `notify.mjs`
  scoped to the pinned request**. `curl` is **not** added to `ALLOWED_COMMAND_LITERALS`.
  The transport is a `node:https` request pinned to the fixed host, **IPv4-preferred with a
  bounded fallback**: the bundled `fetch` (undici) does not fall back to IPv4 on IPv6-broken
  hosts and times out, whereas `node:https` with an explicit address family delivers. The
  fallback to the default/IPv6 family fires **only while no POST body has been written** —
  Telegram `sendMessage` has no idempotency key, so a written body must never be retried.
  The scanner watches `fetch`/`globalThis.fetch`/aliases **and** the pinned `node:https`
  request as network primitives, with fail-closed tests for: non-notify egress, non-POST,
  non-allowlisted origin, missing timeout, redirect-following.

  > **Status (transport fix — [decide-transport] ratified 2026-07-06):** the E1 transport
  > was originally implemented with `fetch`, which **silently failed to deliver** in the
  > owner's IPv6-broken environment (undici `ETIMEDOUT` across GET/POST/IPv4-forced, while
  > `curl -4` succeeded in ~0.8s). Empirically, `node:https` with an explicit IPv4 family
  > delivered 5/5 (real `message_id`); default-family `node:https` and undici both hung.
  > Root cause: default address-family selection fails to fast-fail the dead IPv6 SYN, not
  > "node networking is blocked". The `fetch → node:https` swap keeps the **identical E1
  > effect** (so it needs no ADR-0035 §4 ceiling amendment — only this text), and closes the
  > acceptance gap where `test-cross-machine-egress-acceptance.mjs` used `fakeFetch` and thus
  > never exercised a real socket. `curl`/external-process egress remains rejected (see the
  > `curl` executor rejection below — unchanged).
  >
  > **Status (release-dogfood — real delivery PROVEN 2026-07-06):** the ship gate above is
  > SATISFIED. The shipped `node:https` transport was exercised end-to-end through the REAL
  > `notify.mjs emit` CLI subprocess, over the owner's genuine (IPv6-broken) network, using the
  > owner's real bot credential from the single-source `~/.claude/telegram-notify.json`. Two
  > consecutive sends both resolved `egress_outcome: dispatched` (Telegram `HTTP 200 { ok: true }`)
  > in ~1.0–1.1s each, and the owner **confirmed phone receipt**; the received text matched the
  > enumerated §3 render byte-for-byte, proving no local free-text (title/body) egressed in real
  > delivery. The real credential left NO trace in any persisted artifact/state (leak scan clean).
  > **Rollback decision: none** — the transport delivers in the exact environment that broke
  > `fetch`, so prototype-cutover proceeds (disable the personal curl prototype, wire runtime
  > egress activation per machine, avoid duplicate sends) — realized as the first-class,
  > artifact-only **§12 egress launcher** (`runtime:settings --egress-launcher-plan`). The `AGENTIC_EGRESS_REAL_SMOKE`-gated
  > acceptance smoke ([acceptance-gate]) is the repeatable CI-skipped hook for this proof.
- **(e) Bounded await, not vague fire-and-forget.** A **bounded `await` inside
  `notify.mjs` with a small timeout**, all rejections caught; a slow/failing/
  missing network degrades to a recorded failure, never blocks or throws on the
  hook path.
- **(f) Separate egress payload builder.** Egress uses a dedicated
  **`buildEgressPayload()`** that emits **only** the enumerated fields of §3.
  Tests assert the egress request **never** carries `title`, `body`, `message`,
  `refs.path`, `next_action` free text, transcript, or raw response text —
  ADR-0040's `title`/`body` are for **local** channels only.

### 3. Payload = enumerated progress fields only

The egress body carries **only**: `kind`, `topic` (`repo:branch`, computed from
event-build-time values — **no hidden `git` exec** in the emitter), `hostname`,
`session_hint`, and — when a fresh workflow projection exists — `workflow_id`,
`phase`, plus — **only when the operator opts in (§3a)** — a bounded,
closed-vocabulary `headline` status token. **`next_action` free text is NOT
egressed** (it defeats scrubbing); the "bounded status token if needed" this
sentence anticipated is realized as the opt-in `headline` field defined in §3a
below — a **closed enum, not free text**. **Raw transcript/response text is never
egressed.** The notification is a **trigger + context** ("which machine, what
work, how far along") pulling the operator into the session for detail.

#### 3a. `headline` — bounded closed-vocabulary status token (opt-in) — [decide-headline] 2026-07-07

> **Status: DECIDED design, not yet shipped.** A governance-gated amendment (macro
> `…85bdad`, subtask `adr-amend`). `headline` is the **design of record**; it is
> **not yet implemented or delivered**. Remaining subtasks: `runtime-headline`
> (schema field + opt-in reader + egress/mirror emission), `producer-headline`
> (attention borns the token), `acceptance-headline` (leak/edge tests), and
> `release-dogfood` (two-package release + owner real-delivery proof). Do **not**
> read this section as "runtime ships/delivers headline" until `release-dogfood`
> proves real delivery — mirroring §2d's ship-gate discipline.

- **What it is.** One `headline` field carrying a token from a **fixed, closed
  vocabulary** — e.g. `your-turn`, `needs-approval`, `in-progress`, `blocked`,
  `complete`, `failed` (exact set finalized in `runtime-headline`). It answers
  "*what state is this session in*" in a single machine-stable token. **Zero free
  text** — the value is selected from the closed set, never composed from operator-
  or model-authored characters.
- **Not the rejected free-form `next_action`.** The Alternatives entry rejects
  **free text** in the egress body; a closed enum is not free text. Because
  `headline` is drawn from a fixed vocabulary **enforced at both guards below**, it
  is **secret-free and injection-safe** — it cannot carry a key/token, a transcript
  fragment, or a Markdown/HTML payload — so it does **not** reopen the leak surface
  §3/§5 closed.
  The "Free-form `next_action` — Rejected" alternative therefore **stands**;
  `headline` is the *bounded status token* that entry pointed to (reconciled in
  Alternatives below). The opt-in here is a **format gate**, not the informed
  leak-acceptance lever that free-form egress would have required.
- **Born in attention (two-package scope), enforced at two guards.** The token is
  **produced in the attention package**, derived at event-build time from
  **existing** signals — `kind` (on the event) + `archive_gate` (already in the
  closed projection field set) + terminal status — **not** by extending the closed
  projection schema and **not** derived in the runtime emitter (which sees only the
  event). **Guard 1 (producer): map-or-omit** — only a recognized
  `(kind, archive_gate, terminal-status)` combination yields a token; an unknown or
  absent signal **omits** `headline`, never a guessed value. The runtime package
  adds the schema field, the opt-in reader, and the egress/mirror emission, and —
  **Guard 2 (runtime, load-bearing): validate-or-drop** — MUST check `headline`
  against the closed vocabulary and **drop any out-of-vocab value** before
  scrub/cap/render. Runtime does **not** "egress whatever token attention supplied":
  a producer bug or vocabulary drift is caught runtime-side, not trusted away.
  Runtime **copies, does not import**, the vocabulary constant (ADR-0010 §5
  cross-plugin import ban; mirrors the `hostname`/`session_hint` copy-not-import
  precedent) — so the copied constant + both mapping tables MUST be
  **parity-tested** across `attention`/`runtime` to catch drift.
- **Opt-in = a format/verbosity gate, not leak-acceptance.** Populating `headline`
  requires a **separate, default-OFF opt-in** — env `AGENTIC_NOTIFY_EGRESS_HEADLINE`
  or a verified-ignored-local `egress_headline` key — **distinct from egress
  activation (§2c)**. Its role is **verbosity/format control**, not informed
  acceptance of residual leak risk (there is none once the closed vocabulary is
  enforced at both guards below — the field carries no free text), which is why it
  can default OFF without weakening safety. It is
  **fail-closed** (an unset/invalid opt-in omits `headline` **without** suppressing
  the base egress notification), **tracked-config-inert** (tracked
  `.agentic-plugins/config.toml` can never enable it — §2c's verified-ignored-local
  rule), and **opt-in-alone inert** (enabling the headline opt-in without egress
  activation does nothing).
- **Cross-host degradation — Claude-Stop-only at v1.** The token needs the
  attention producer's fresh projection, so it populates on the **Claude Stop
  path** at v1. The Codex `notify=` shuttle carries **no** projection (it emits a
  bare `turn-complete` event), so at v1 **Codex omits `headline` entirely** — a
  `kind`-only token (e.g. `turn-complete`→`complete`) would overstate a single turn
  as session/workflow status, so it is deliberately **not** derived; the base
  notification is unaffected.
- **Stays within the E1 ceiling (no new precedent).** `headline` is a payload
  refinement **inside** the existing `E1 — enumerated-metadata network egress`
  tier, not a new effect domain — a closed enum is squarely "enumerated metadata",
  so it needs **no** ADR-0035 §4 ceiling amendment and **no** ADR-0040 §2 change.
  This does **not** establish a general "closed-enum fields are always admissible"
  rule: each future egress field still enters only by updating §3's enumerated
  payload list and the §5 / acceptance leak-scans (the standing review obligation
  in Consequences → Negative).

### 4. Event schema §1 extension (exact)

Extend the ADR-0040 schema (`event_id/source/kind/title/body/urgency/refs`) with
`hostname`, `topic`, `session_hint` as **redacted, capped, display/routing**
fields (+ `workflow_id`/`phase` in `refs`). Define per-field caps and the
Telegram rendering (**plain text, no `parse_mode`** unless fully escaped).
`hostname` + `session_hint` (host + short session-id/prompt-id hash, **no
transcript**) give a stable per-event identity so same-host/repo/branch ssh+tmux
sessions stay distinct. `event_id`/dedupe incorporate `hostname`; dedupe state
stays **per-machine** (local), making multi-device → one-chat inherent.

**`headline` schema field (opt-in, §3a).** Add `headline` as one more **capped,
plain-text** field, populated by the attention producer from the closed
vocabulary of §3a. Its per-field cap is small — it bounds a single known token
(the longest vocabulary member plus headroom; finalized in `runtime-headline`) —
and capping a closed-vocab value is a **uniform-treatment guard, not a leak
control**. Unlike a free-text field, `headline` introduces **no new injection
surface** once the runtime enum-guard (§3a Guard 2) drops out-of-vocab values: the
closed vocabulary contains no `parse_mode` metacharacters, so the existing
plain-text (no-`parse_mode`) Telegram render already covers it. With that guard and
the acceptance leak-scans in place it is the **lowest**-risk display field — not, as
an earlier free-text framing supposed, the highest. Implementation note: `headline` is a **separate optional field**, **not**
added to the unconditionally-iterated routing-field list — validation/payload/
mirror/parity passes that walk the routing fields do not carry it by default; it
is emitted only under the §3a opt-in.

### 5. Egress-only secret-scrub redaction (defense-in-depth, not a proof)

Before egress dispatch (egress channels only), add a **secret-scrub** pass
(bearer-token / credential-URL / key-shaped patterns) atop allowlist + cap +
control-strip. This **reduces** exposure; it is **not** a proof no secret
escapes — which is why §3 keeps the field set enumerated and drops free text.
Local channels keep current redaction.

**Scrub-before-cap ordering (acceptance hardening).** The scrub MUST run **before**
each per-field cap, in both the egress body (`buildEgressPayload`) and the
attempt-mirror (`buildEgressMirrorRecord`): a secret longer than a field cap would
otherwise be truncated — losing its `@` / marker — *before* the scrub sees it,
leaking a fragment. Normalizing then scrubbing the full value then capping closes
that path. (Caught by the acceptance-gate adversarial ensemble.) The opt-in
`headline` token (§3a) is first **dropped if out-of-vocabulary** by the runtime
enum-guard (§3a Guard 2) — that omit-not-coerce guard, not the scrub, is its primary
control — then covered by this **same** scrub-before-cap pass in **both** the body
(`buildEgressPayload`) and the mirror (`buildEgressMirrorRecord`) as
defense-in-depth, uniform treatment so a future vocabulary change cannot silently
regress. A valid closed-vocabulary token carries no secret and cannot exceed its
cap, so the pass has nothing to remove today.

**Local-state scoping (out of egress scope, on record).** The ADR-0040 dedupe
**claim** file stores the raw `event_id` verbatim (local debuggability + the
dashboard's per-event inspect). It is read only by the dedupe check and the
dashboard (by `stat`, never the body) and **never egresses** — the egress payload
provably excludes `event_id`, the mirror scrubs it, and the throttle stores a
hash. So a malformed producer parking token-shaped material in `event_id` is
**not** an E1 egress leak (the credential itself is env-only and reaches no
artifact). Minimizing that raw value in the local claim is a **separate local-state
hardening concern**, deliberately out of this ADR's egress threat model.

### 6. Dashboard/statusline integration (attempt-visible)

The channel **mirrors a sanitized attempted event to `file-log` before network
dispatch**, recording `egress_channel` + `egress_status` (dispatched/suppressed/
failed). `runtime:dashboard` Tier 2 and statusline `🔔` reflect reality —
including missing-token/failed attempts — without the network step blocking or
hiding outcomes. (Sanitized = no token/token-shaped value, per §2b.)

**Scope clarification (plugin homes vs user layer).** The **attempt-mirror**
(the `file-log` NDJSON row) and **`runtime:dashboard`** Tier 2 are the *plugin
homes* for egress observability — both ship in this ADR and read the same
per-machine notify-state. The **statusline `🔔`** is a **user-layer read** of that
same state, **not** a plugin-shipped writer: consistent with ADR-0040's
`statusLine`-deferral (runtime ships no statusline component; the operator's own
statusline script surfaces the `🔔`). So "dashboard/statusline integration" means
the plugin populates the notify-state (mirror + dashboard); the statusline merely
consumes it at the user layer. *(Amended by
[ADR-0048](0048-bootstrap-observability.md) §2, 2026-07-23: "no statusline
component" is narrowed to "no **automatically installed** statusline
component" — see the Amendment at the end of this file.)*

### 7. Dedupe + failure semantics (claim finalization + failure throttle)

Dedupe is claimed **before** dispatch (ADR-0040). E1 uses an explicit **claim
finalization** model: pre-claim → dispatch → **promote** the claim on success,
**release only the owned claim** on failure — so a **failed** dispatch (missing
token, timeout, provider error) does **not** consume the success TTL (which would
suppress the useful retry after the operator fixes config). To keep that release
from opening a **retry storm**, E1 adds a **short failure cooldown/backoff
throttle** keyed by `(event + service + config/credential fingerprint)`: a
persistent provider timeout/error does not re-dispatch on every repeated event,
but the throttle is **bypassed** the moment the operator fixes missing/changed
config or credential (fingerprint change). Tests cover: missing token, timeout,
**repeated provider failure (throttle engages)**, later success within TTL, and
**config-fix bypass**. This is an **E1-specific amendment to ADR-0040's dedupe
persistence semantics** — called out for acceptance so the two rules do not read
as contradictory.

### 8. Multi-machine / multi-session

**All machines × all sessions → one chat.** Each machine's operator provides the
same recipient via env or verified-ignored-local config (**never an init-time
secret write** — operator-provided, not runtime-mutated, honoring §4's
no-token-mutation ceiling). Each session's hooks fire independently through the
same emitter → channel; `hostname` + `session_hint` keep them distinct. No
central collector — Telegram is the fan-in point.

### 9. Service-admission checklist (future services)

A future service (Slack/ntfy/Discord/…) enters E1 **only** via a service-specific
ADR proving all of: fixed SaaS origin (no arbitrary/self-host URL under E1); no
redirects; **credential-only** user input (no URL); recipient shape validation;
fixed method + body keys; no rich formatting unless fully escaped;
enumerated-metadata payload only; the §2 hard conditions re-cleared. E1 is a
**durable, service-agnostic** frame; each service pins its own request.

### 10. Owner-decision gate

- **Accept** if E1 means exactly: fixed-service, no-user-URL, env-secret,
  mechanically-verified-local activation, enumerated-metadata only. Then it is a
  **bounded** §4 amendment, not a general network-egress precedent.
- **Forbid** (fall back to Alternative A) if the ignored-local activation cannot
  be mechanically proven safe in arbitrary consumer repos, or if a wanted future
  service would require arbitrary/self-host URLs.
- **Decision driver**: recurring multi-machine demand (**confirmed here**) vs a
  single personal workflow. Recurring → the accept case is live.

### 11. Acceptance obligations + implementation

On acceptance: update **ADR-0035 Status/§4** ("§4 amended by ADR-0041 — E1") and
**ADR-0040 §2** deferred-channel text (point here). Tests required: executor-guard
registry + scanner network-primitive coverage (`fetch`/`node:https`, §2d), pinned-request fake-token unit test
(§2b), `buildEgressPayload()` exclusion test (§2f), dedupe-failure tests (§7),
redaction/secret-scrub test (§5), attempt-mirror test (§6), cross-host acceptance.
Implementation is a **`orchestrator:plan` multi-deliverable (~5-6 PRs)** with the
**scanner/registry gate landing before or with any network-egress-primitive use**: (1) ADR-0035/
0040 boundary-doc updates; (2) verified-ignored-local + config/schema; (3) event
schema + attention `hostname`/`session_hint` (copy-not-import); (4) executor
scanner/registry network-primitive gate; (5) Telegram HTTPS (`node:https`) channel + redaction/mirror; (6)
acceptance tests. The **prototype-cutover** step (§2d Status / §8) is realized as
the first-class, artifact-only **§12 egress launcher** — a planner that writes no
activation, so it lands as an ordinary runtime feature, not a §4-gated slice.

### 12. First-class egress launcher (`runtime:settings --egress-launcher-plan`) — [egress-launcher] 2026-07-07

The prototype-cutover track (§2d Status / §11) — retire the personal `~/.claude`
curl prototype, wire runtime egress activation per machine, avoid duplicate sends
— is realized as a **first-class, artifact-only planner** in `runtime:settings`,
structurally mirroring `--notification-plan` (§6 / ADR-0040 §4).

- **What it is.** `runtime:settings --egress-launcher-plan` reads the current
  egress activation state (`loadEgressActivation`, §2c) and the personal
  `~/.claude/settings.json` prototype hooks **read-only**, computes a
  **state-aware mode** (`activate` / `partial` / `prototype-retire-only` /
  `already-active`), and records a per-machine activation runbook — the
  `config.local.toml` content (channel + chat-id), the env credential line, the
  exact prototype hook entries to remove, verify, rollback, and the per-machine
  repeat (§8) — into an `.agentic-plugins/runs/egress-launcher/` plan artifact.
- **Artifact-only is load-bearing, not cosmetic.** The launcher **never writes**
  host config, `~/.agentic-plugins/config.local.toml`, the credential, or
  `~/.claude/settings.json`. §2c makes egress activation a value that must come
  only from the operator env or a fail-closed-verified ignored-local file,
  precisely so no tool path can activate egress; a launcher that *wrote* the
  activation would itself become the egress-activation vector §2c closed.
  Applying the plan (creating the file, exporting the token, disabling the
  prototype hooks) is an explicit **user** action — the same
  render-and-record-only discipline as the notification plan's receiver install.
- **Strictly within — in fact below — the E1 ceiling (no new precedent).** The
  launcher is a **planner**: it emits **no network effect** and writes **no
  activation**, so it is strictly less than an E1 egress and needs **no**
  ADR-0035 §4 amendment. The credential is **never read** (only its presence is
  surfaced, §2b); a boundary-invariant artifact validator refuses to write unless
  every `boundary.writes_*` flag is `false`, and a `scrubSecrets` (§5) pass
  fail-closes the write if any secret-shaped value ever reached the artifact. The
  recommended layout keeps channel + chat-id in the verified-ignored-local file
  and the token in env; an env-all layout is shown as an alternative (§2c honors
  both for channel/recipient; the credential is env-only either way). The
  `egress_*` keys stay **outside** runtime-config `CONFIG_KEYS`, so `--apply` can
  never write them and the launcher never adds them.
- **Detection-informed, not a generic checklist.** Prototype detection matches by
  **exact path** (`~/.claude/telegram-notify.mjs`), never a basename-anywhere
  heuristic that would misclassify an unrelated same-named script, and is
  Claude-scoped (the personal hook). A machine already cut over gets an
  `already-active` no-op verification plan; a machine whose prototype hooks are
  already gone gets no misleading "disable" step — the state-aware plan tells the
  operator only what is true on *this* machine.

## Consequences

**Positive**

- Multi-machine, multi-session attention converges to one device as a **project
  capability** — install + one env var (+ optional verified-local recipient), no
  bespoke hook. Project tools recognize it (unified config + attempt-visible
  mirror). One channel serves **both hosts**.
- Exposure is **reduced** (env-only credential + enumerated capped body + no
  transcript/free-text + pinned no-redirect request + egress scrub + separate
  builder + verified-local activation) — reduced, **not eliminated** (honest).

**Negative**

- §4's ceiling gains a **new permanent effect domain** (network egress). This
  creates **precedent-erosion pressure** ("this is egress too, so…"); the
  **enumerated-metadata + fixed-service + verified-local** narrowing is the
  deliberate suppressant that keeps E1 from generalizing. Standing review
  obligation (registry, network-primitive scanner, redirect/pinning, activation-proof).
- Credential + recipient are per-machine operator responsibility — "install-only"
  is "install + env var (+ optional verified-local recipient)".
- New paths to maintain/test: egress scrub, attempt-mirror, pinned-request
  validation, separate egress builder, verified-ignored-local reader.
- Codex asymmetry: the channel reaches Codex, but enumerated metadata is richest
  under workflow projections; a bare Codex turn yields less context. The opt-in
  `headline` token (§3a) inherits this — it is **Claude-Stop-only at v1** (the
  Codex `notify=` shuttle carries no projection) and is **omitted entirely on
  Codex** at v1, since a `kind`-only token would overstate a single turn as session
  status.

**Neutral**

- The `~/.claude` prototype remains a valid personal layer until this ships;
  superseded on release.
- Telegram-only at v1; other services are §9 admissions via follow-up ADRs.
- Transcript enrichment is deferred to a separate, **local-only** decision,
  deliberately decoupled from egress (must never combine).

## Alternatives Considered

- **A — Forbid in runtime, ship a documented user-layer recipe.** *Rejected as
  default, retained as the §10 fallback*: the demand is recurring and this
  forecloses a useful capability, leaving operators to hand-maintain per-machine
  hooks with no project visibility or tests. Becomes the choice if §10's Forbid
  conditions hold.
- **C — Hybrid: local enrichment in-project, egress in a separate bridge
  plugin.** *Rejected*: splits one capability across two homes, still needs a §4
  answer for the bridge, only partially delivers "install-only".
- **Arbitrary user-supplied webhook URL.** *Rejected*: network form of
  "arbitrary/user-supplied argv" — inside §4's MUST-NOT; configuration does not
  neutralize it (effect, not ownership).
- **Transcript-raw egress (even opt-in).** *Rejected*: irreducible secret-leak
  risk best-effort scrubbing cannot close; opt-in only **transfers** risk.
- **Free-form `next_action` in the egress body.** *Rejected — and stays
  rejected*: free text defeats scrubbing. The replacement this entry names — "a
  bounded status token" — is realized as the opt-in, **closed-vocabulary**
  `headline` field (§3a): a closed enum **enforced at both a producer map-or-omit
  and a runtime validate-or-drop guard** is secret-free and injection-safe, so
  admitting `headline` is **not** re-admitting this rejected free-form entry.
  (Design decided 2026-07-07 [decide-headline]; not yet shipped — see §3a Status.)
- **Channel/recipient/token in tracked `config.toml`.** *Rejected*: tracked +
  echoed to artifacts — a repo-controlled activation/exposure vector. Env or
  verified-ignored-local only; token alone never activates.
- **`curl` executor.** *Rejected for scoped in-process `fetch`*: a shell binary
  opens arbitrary egress; the pinned, no-redirect, registry-scanned `fetch` is
  narrower.
- **Host-pin without full-request pin.** *Rejected*: `fetch` follows redirects,
  so host-pinning alone does not bound egress; full URL + `redirect:"error"` +
  shape validation is required.

## Amendment (2026-07-23): §6 statusline wording — narrowed by ADR-0048 §2

§6's "runtime ships no statusline component; the operator's own statusline
script surfaces the `🔔`" is amended to: **runtime ships no automatically
installed statusline component; runtime MAY render a credential-free Claude
statusline shim as an artifact for explicit operator installation** (Codex
remains fragment-only over its native `[tui].status_line` ordered list). The
user-layer read stays optional and the notify-state remains the plugin home;
nothing in this amendment changes §2's hard conditions — statusline inline
commands and shims MUST NOT read the credential variable (ADR-0048 §4).
