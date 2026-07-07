# Release proof — ADR-0041 §3a opt-in headline egress

**Ship gate for `macro-plan-20260706T151421Z-85bdad` subtask `release-dogfood`
(verb=critique, profile=architecture).** This is a *required ship gate, not
ordinary CI* (per the subtask topic): it records that the ADR-0041 §3a opt-in
closed-vocabulary `headline` status token was **released in both packages** and
that a **real cross-machine Telegram delivery** carried the headline with no
free-text/secret leak, plus the rollback decision. Verdict at the bottom.

> **Boundary.** This gate covers *release + real-delivery proof of the
> mechanism*. Activating the runtime egress channel inside the owner's genuine
> installed hook environment (replacing the personal `settings.json` Telegram
> prototype) is **`prototype-cutover`, a SEPARATE macro** (owner Option-3
> sequencing) — deliberately **not** performed here.

## 1. Releases cut (the "Release BOTH plugins" step)

Both release-managed packages carrying the §3a headline code were published via
release-please PR **#512** (`chore: release main`, merge `2dc2aef`), with the
Claude marketplace catalog version entries synced by the follow-up commit
`ac5539f` (the Codex catalog `.agents/plugins/marketplace.json` is versionless by
design — its shape/presence is validated, but it carries no per-entry version):

| Package | Version | Headline code shipped | Tag / release |
| --- | --- | --- | --- |
| `plugin-attention` | 0.3.1 → **0.4.0** | producer — `deriveHeadlineToken` (Guard 1 map-or-omit) in `scripts/lib/sensor.mjs` | `plugin-attention-v0.4.0` |
| `plugin-runtime` | 0.74.1 → **0.75.0** | runtime — `loadEgressHeadlineOptIn` + `HEADLINE_VOCAB` + `isHeadlineToken` (Guard 2 validate-or-drop) + `buildEgressPayload`/`buildEgressMirrorRecord` headline threading | `plugin-runtime-v0.75.0` |

Verification (release tags actually contain the code, not just a version bump):

- `git show plugin-attention-v0.4.0:plugins/attention/scripts/lib/sensor.mjs` →
  `deriveHeadlineToken` present.
- `git show plugin-runtime-v0.75.0:plugins/runtime/scripts/lib/egress-config.mjs`
  → `loadEgressHeadlineOptIn` present; `…/notify-schema.mjs` → `HEADLINE_VOCAB`
  present.
- `validate:versions` / `validate:marketplace` / `validate:artifacts` green at
  `ac5539f` (Claude catalog entries == manifest == attention 0.4.0 / runtime
  0.75.0; the Codex catalog is versionless by design, so it is shape-validated,
  not version-checked).

> **CI note.** The release commit `2dc2aef` shows transient
> `marketplace-validate` / host-test failures — the documented catalog↔manifest
> drift window *before* the sync commit. `ac5539f` resolves the drift; it carries
> no CI run of its own because a release-please bot push (GITHUB_TOKEN) does not
> re-trigger workflows. Health was confirmed by the local `validate:*` runs above
> plus the prior #514 CI on `e004dbb` (the release commits change only
> versions / CHANGELOG / catalog, not test or product code); the doc-freshness +
> sign-off PR then re-runs full CI on top of this state.

## 2. Real cross-machine delivery proof (real network + real credential)

Deterministic CI is *necessary but not sufficient* (§2d): every acceptance gate
injects a transport double and never opens a socket. The real delivery was
proven out-of-band with the owner's genuine Telegram bot credential
(`@e16tae_notification_bot`, label `e16tae`) over the real `node:https`
transport:

- **Mechanism:** the `(K2)` opt-in real-network smoke in
  `tests/acceptance/test-cross-machine-egress-acceptance.mjs`
  (`AGENTIC_EGRESS_REAL_SMOKE=1`), which runs the real `runEmit` egress pipeline
  with **no** `fetchImpl`, so a real socket opens to `api.telegram.org`.
  Result: `status: dispatched`, K2 `pass 1 / fail 0`.
- **Owner phone confirmation (byte-for-byte):**

  ```
  approval · complete · @mba · repo:main · wf wf-1/phase-3 · sess12
  ```

  The received message is byte-for-byte the enumerated §3 render: `complete`
  (the §3a headline) sits immediately after the `kind`; the body carries **only**
  the enumerated fields (kind · headline · @hostname · topic · wf id/phase ·
  session_hint) — **no** title/body/message/next_action/transcript/refs.path free
  text, **no** secret, **no** control bytes.
- **Real-producer path (scoped):** the `(L7)` acceptance test (shipped in #514)
  proves the **real** attention Stop sensor borns the headline through
  `deriveHeadlineToken(ready_to_archive) → complete` into the egress **mirror**
  (a genuine accepted `readFreshProjection`, not synthetic event JSON — Codex
  PEER-10). This is proven only *to the mirror* (network-free); the delivered
  Telegram *body* from the real producer is not directly observed. The composed
  proof is therefore: **L7** (real producer → mirror) + **L1/L2** (`event.headline`
  → body, identical token) + **K2** (a **synthetic** `egressEvent({headline:
  'complete'})` dispatched over the real `node:https` transport, owner-confirmed on
  the phone).
- **Leak scan clean (scoped):** no free-text/secret/sentinel appears in the
  owner-confirmed message or in the acceptance sentinel/token scans (the
  `(H)`/`(L6)`/`(L6b)` scans of argv/stderr/artifacts/state, plus the module-load
  ambient-credential scrub, hold with the headline present). This is the
  *observed/tested* path plus the structural headline-specific guarantee below —
  the **headline** leak class is closed by exact-vocab drop; it is not a universal
  claim that no value can ever appear in any enumerated routing field.

## 3. Leak-safety basis (why the headline is ship-safe)

- **Closed vocabulary, validate-or-drop:** `headline` is one of exactly six
  tokens `{your-turn, needs-approval, in-progress, blocked, complete, failed}`.
  `isHeadlineToken` (exact membership) gates **upstream of the per-field cap**, so
  a secret/markup/control/padded/unknown value is dropped entirely — a
  scrub-after-cap fragment leak cannot even arise for this field.
- **No free text by construction:** the egress payload is the enumerated §3 field
  set only; the Telegram body is `{ chat_id, text }` with **no** `parse_mode`
  (no markup-injection surface).
- **Two guards agree:** the attention producer maps structured signals
  (kind + archive_gate) → a token or omits (Guard 1); the runtime egress builders
  validate-or-drop against a copy-not-import vocab (Guard 2), with a
  producer/runtime parity test.
- **Acceptance gate:** #514 (`(L)` + `(K2)`), 65 tests, adversarially reviewed
  (Codex Plan-verify + an independent fresh-eyes pass), full suite green.

## 4. Rollback decision

The headline is an **opt-in, default-OFF** field
(`AGENTIC_NOTIFY_EGRESS_HEADLINE` env / `egress_headline` in the verified
user-home local file; tracked config can never enable it). Egress activation is
itself opt-in + fail-closed.

**If headline delivery ever misbehaves, it ships safe with no rollback release:**
leave the opt-in unset (the default) and the field is simply never emitted — the
rest of the egress channel is unaffected. A code rollback is therefore *not* on
the critical path; the format gate is the rollback.

## 5. Verdict — SHIP GATE: PASS

- ✅ Both packages released with the §3a headline code (attention 0.4.0, runtime
  0.75.0; tags + GitHub releases + Claude catalog synced; Codex catalog is
  versionless by design).
- ✅ Real cross-machine Telegram delivery carried the headline (`complete`),
  byte-for-byte enumerated render, owner-confirmed; no leak in the observed
  message + acceptance scans (headline leak class closed by exact-vocab drop).
- ✅ Composed proof: L7 (real producer → mirror) + L1/L2 (`event.headline` → body)
  + K2 (synthetic headline event over the real `node:https` transport,
  owner-confirmed). The real producer → delivered-body link is by composition, not
  a single spanning observation.
- ✅ Rollback safe by construction (opt-in default OFF).

Remaining follow-up is **`prototype-cutover`** (separate macro). The installed
plugins are already updated to attention 0.4.0 / runtime 0.75.0 on both hosts (the
doc-freshness recovery accompanying this sign-off); the cutover proper is
**activating** the runtime egress channel in the genuine hook environment and
retiring the personal `settings.json` Telegram prototype.
