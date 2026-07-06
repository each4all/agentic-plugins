# ADR-0041: Cross-machine notification egress

## Status

Accepted (2026-07-06)

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
  > egress activation per machine, avoid duplicate sends). The `AGENTIC_EGRESS_REAL_SMOKE`-gated
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
`phase`. **`next_action` free text is NOT egressed** (it defeats scrubbing);
replaced by a bounded status token if needed. **Raw transcript/response text is
never egressed.** The notification is a **trigger + context** ("which machine,
what work, how far along") pulling the operator into the session for detail.

### 4. Event schema §1 extension (exact)

Extend the ADR-0040 schema (`event_id/source/kind/title/body/urgency/refs`) with
`hostname`, `topic`, `session_hint` as **redacted, capped, display/routing**
fields (+ `workflow_id`/`phase` in `refs`). Define per-field caps and the
Telegram rendering (**plain text, no `parse_mode`** unless fully escaped).
`hostname` + `session_hint` (host + short session-id/prompt-id hash, **no
transcript**) give a stable per-event identity so same-host/repo/branch ssh+tmux
sessions stay distinct. `event_id`/dedupe incorporate `hostname`; dedupe state
stays **per-machine** (local), making multi-device → one-chat inherent.

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
that path. (Caught by the acceptance-gate adversarial ensemble.)

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
consumes it at the user layer.

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
acceptance tests.

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
  under workflow projections; a bare Codex turn yields less context.

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
- **Free-form `next_action` in the egress body.** *Rejected*: free text defeats
  scrubbing; replaced by a bounded status token.
- **Channel/recipient/token in tracked `config.toml`.** *Rejected*: tracked +
  echoed to artifacts — a repo-controlled activation/exposure vector. Env or
  verified-ignored-local only; token alone never activates.
- **`curl` executor.** *Rejected for scoped in-process `fetch`*: a shell binary
  opens arbitrary egress; the pinned, no-redirect, registry-scanned `fetch` is
  narrower.
- **Host-pin without full-request pin.** *Rejected*: `fetch` follows redirects,
  so host-pinning alone does not bound egress; full URL + `redirect:"error"` +
  shape validation is required.
