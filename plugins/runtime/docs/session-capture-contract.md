# Session Capture Contract — slot / entry / note

Normative schema and behavior contract for the ADR-0044 session-generic
handoff capture surface: the `session_capture` config gate, the
`.agentic-plugins/state/runtime/session-capture/` artifact home, the three
packaged schemas, the fingerprint algorithm, and the publisher/consumer
rules. Durable **policy** lives in
[ADR-0044](../../../docs/adr/0044-session-generic-handoff-capture.md); this
document owns everything that **moves**: field tables, caps, TTLs, the
fingerprint input, temp naming, sweep bounds, and the commit-record rules.
ADR-0045 §12 extends this same document with the entry-side (arbiter)
contract when that surface ships — this file is the shared exit+entry home.

Decided 2026-07-18 (macro `macro-plan-20260718T111223Z-ccc3c7` subtask
S2-cap-foundation). This document **ships inside the runtime plugin
package** (the machine-bootstrap-contract.md precedent): a runtime command
invoked from an arbitrary consumer repository reads `PLUGIN_ROOT/docs/…`,
never `repoRoot/docs/…`. Line references to other files are anchors observed
at decision time and may drift; **the contract text governs**.

---

## 1. Scope and boundaries

The session-capture surface is:

- **M1, repo-scoped** — it writes only under the repo-local
  `.agentic-plugins/state/runtime/session-capture/` home. Non-git cwd ⇒
  silent no-op. The machine-global `~/.agentic-plugins` home is
  bootstrap-only and is NOT extended here (ADR-0044 §4).
- **Config-gated, default off** — the `session` config family carries
  `session_capture` (enum `off | stop-hook`, shipped default `off`). The
  gate is evaluated **inside the publisher executor**, never in the
  attention sensor (the `notify_channel` shape; ADR-0044 §3). The value is
  an enum, not a boolean, so a future origin can join without a schema
  break. Effective value resolves repo → user-global → shipped default via
  the shared `lib/runtime-config.mjs` loader (`loadSessionConfig`), which
  fail-closes on an unreadable config layer or an invalid effective value —
  a broken config never turns capture on.
- **Hook-grade on the publisher path** — `publish-session` (and `note` when
  hook/sidecar-invoked) exits 0 always, writes nothing to stdout, and emits
  at most one stderr line. Operator invocations of `note` and
  `status --slot` stay on the reporter output path (stdout report, exit 1
  on error). A capture failure must never break a turn, hook, or commit.
- **A rolling turn-complete checkpoint** — the last successful refresh
  before a session ends, however it ends, *is* the handoff. Abrupt
  termination emits no final capture; the previous turn's slot is the
  handoff (the rolling-checkpoint limit, stated honestly).

## 2. Artifact home and files

```
.agentic-plugins/state/runtime/session-capture/
  slot.json    # raw capture — schema runtime-session-capture-1.0
  entry.json   # sanitized projection + commit record — schema runtime-session-entry-1.0
  note.json    # staged semantic note — schema runtime-session-note-1.0
  .lock        # publisher mutex (O_EXCL; owner token; §8)
  *.tmp-*      # uniquely named write staging (§7); swept per §7.3
```

A slot, not a ledger: a turn-frequency event refreshing one directory is
O(1) on disk. The append-only `.agentic-plugins/runs/context/` ledger
remains reserved for **explicit** `runtime:context capture` runs,
unchanged; the two shapes are distinguished by `origin`.

Temp naming: `<final-name>.tmp-<pid>-<random-hex>` in the same directory
(same-filesystem rename). The lock file is `.lock`, holding the owner token
(§8). No other file may appear in this directory; unknown files are ignored
by readers and are candidates for the §7.3 sweep only when they match the
temp pattern.

## 3. Schemas

The three packaged schemas under `data/schemas/` are the **load-bearing**
validation source — loaded through `lib/schema-validate.mjs`
`loadSchema(family)` (families `runtime-session-capture`,
`runtime-session-entry`, `runtime-session-note`); executors and consumers
never hand-roll a second field list. All three follow the closed-schema
rule: unknown object keys fail validation at any depth. The publisher
validates **before** rename; every consumer schema-validates and
**skips fail-closed** on mismatch, with slot/entry/note each recovering
independently — a malformed file is skipped by readers and overwritten by
the next publish; it is never repaired in place, never deleted on read.

**Strict versioning, deliberately diverging from the bootstrap posture**:
each packaged session schema pins the exact schema id (`…-1.0`), so a
document declaring a newer minor is **rejected**, never forgiven — the
validator's newer-minor unknown-scalar forgiveness cannot apply, because it
would let a `-1.1` document smuggle an unknown scalar (e.g. an imperative
`next_action`) past `entry.json`'s fixed field set (ADR-0044 §7). The
forgiveness posture exists for artifacts whose producer and consumer can be
different runtime versions; slot/entry/note are produced and consumed by
the same installed runtime, so cross-version tolerance buys nothing and
costs the injection boundary. Every single-line string field structurally
excludes the C0 control range (U+0000–U+001F) and DEL (U+007F), not merely
CR/LF — the `clampReinjectField` stripping discipline expressed as a
schema pattern.

### 3.1 `slot.json` — `runtime-session-capture-1.0`

Raw capture. Every field required; absence is expressed as `null`, never by
omission. Observer labels are normative (ADR-0044 §1).

| Field | Type | Observer | Semantics |
| --- | --- | --- | --- |
| `schema` | string | — | `runtime-session-capture-1.<minor>` |
| `captured_at` | ISO-8601 UTC (`…Z`) | publisher | publication instant |
| `origin` | enum `stop-hook` | publisher | producing path |
| `summary_source` | enum `staged-note \| structural` | publisher | channel honesty: `staged-note` asserts only that an explicit local `context note` invocation staged the folded content |
| `host` | enum `claude \| codex` | sensor-relayed | validated argv, never a publisher observation |
| `session_id` | string ≤128, single-line, nullable | sensor-relayed | clamped; `null` when the hook payload carried none |
| `repo_recent_terminal_evidence` | enum `none \| fresh` | sensor-relayed | repo-level, last-observed; recorded, **never suppressed on** (§5.3); absent flag ⇒ `none` |
| `repo_root` | string ≤1024, single-line | publisher | settlement (a): a Tier-1 fact recorded in the RAW slot for diagnosis; deliberately **absent from `entry.json`** so the injected-surface projection stays path-free |
| `branch` | string ≤256, single-line, nullable | publisher | `null` on detached HEAD |
| `head_short` | hex 7-40, nullable | publisher | `null` on unborn HEAD / probe degradation |
| `dirty_count` | number, nullable | publisher | `null` when the porcelain probe overflowed or errored |
| `status_digest` | sha256 hex (64), nullable | publisher | §6; `null` = **unknown, never clean** |
| `note` | object, nullable | publisher | the folded note **verbatim with its staging metadata** (mirror of `note.json` minus `schema`); `null` when no note is inside the fold window |
| `fingerprint` | `fp1:` + sha256 hex | publisher | §5; identical in `slot.json` and `entry.json` within one committed generation |

### 3.2 `entry.json` — `runtime-session-entry-1.0`

The sanitized entry projection **and** the §7 commit record — the ONLY
session-capture file the entry side (ADR-0045) reads, and the only file the
publisher's no-op decision reads. Fixed field set; unknown keys forbidden;
every string single-line and length-clamped; deliberately **no imperative
field** (no `next_action`, no recommended command — the SessionStart
reinjection exclusion ruling is inherited), **no `repo_root`, no paths**,
**no note body** (only the clamped first line). Consumers recompute
staleness from `captured_at` / `note_staged_at`; there is no pre-computed
age field. Every field below is **required-null**, not optional-absent:
ADR-0044 §7's "absent when `summary_source = structural`" is realized as
`summary_line: null` — absence-as-null keeps the key set fixed and makes an
omitted key a schema violation rather than an ambiguity (same rule for
`note_staged_at`).

| Field | Type | Semantics |
| --- | --- | --- |
| `schema` | string | `runtime-session-entry-1.<minor>` |
| `captured_at` | ISO-8601 UTC | = slot's `captured_at` for the same generation |
| `origin` | enum `stop-hook` | |
| `summary_source` | enum `staged-note \| structural` | |
| `host` | enum `claude \| codex` | |
| `branch` | string ≤256, nullable | the one generic-source field ADR-0045 can branch-check |
| `head_short` | hex 7-40, nullable | |
| `dirty_count` | number, nullable | |
| `repo_recent_terminal_evidence` | enum `none \| fresh` | |
| `summary_line` | string ≤160, single-line, nullable | clamped FIRST line of the folded note; `null` when `summary_source = structural`; **untrusted quoted data** for every consumer |
| `note_staged_at` | ISO-8601 UTC, nullable | staging instant so consumers recompute note staleness |
| `fingerprint` | `fp1:` + sha256 hex | commit-record fingerprint (§7) |

### 3.3 `note.json` — `runtime-session-note-1.0`

The repo-global staging slot written only by the explicit
`runtime:context note` invocation (`--text | --file | --clear`) — the
explicit invocation is itself the ADR-0035 invariant-1 opt-in for this
write. Honestly per-repo, not per-session: the CLI has no trustworthy
session identity, so the staging-time git context is what lets a consumer
weigh a note staged on another branch or hours earlier.

| Field | Type | Semantics |
| --- | --- | --- |
| `schema` | string | `runtime-session-note-1.<minor>` |
| `staged_at` | ISO-8601 UTC | instant of THIS staging write; re-staging identical text refreshes it (settlement (b)) |
| `host` | enum `claude \| codex`, nullable | supplied by the invoking wrapper when known |
| `branch` | string ≤256, nullable | staging-time; `null` on detached HEAD / degradation |
| `head_short` | hex 7-40, nullable | staging-time |
| `content` | string | the note verbatim; **4096-byte cap enforced by the writer in UTF-8 bytes** (never JSON Schema `maxLength`, which counts codepoints — the packaged schema's `maxLength` is only a backstop); multi-line allowed — single-line clamping happens only at the entry projection |
| `content_hash` | `sha256:` + hex | hash of the exact content bytes |

`note --file` reads only a regular file: `lstat` no-follow — FIFOs,
devices, and symlinked sources are rejected — bounded to the byte cap.
`--clear` empties the staging slot explicitly (removes `note.json`).
Expired notes (outside the fold window) are ignored, not deleted.

## 4. Policy numbers

The single normative home for the ADR-0044 §4 defaults. Changing any value
is a contract change (minor bump of this document's obligations), not a
code-local tweak.

| Policy | Value | Applies |
| --- | --- | --- |
| Refresh TTL | **300 s** | §5.1 no-op window: a committed, fingerprint-matched generation younger than this is not republished |
| Lock stale-age | **60 s** | §8 takeover threshold |
| Future-skew tolerance | **60 s** | one uniform bound for lock ages, TTL comparisons, and fold-window arithmetic (clock rollback / future mtimes) |
| Note content cap | **4096 UTF-8 bytes** | writer-enforced at `note` (text and file paths both) |
| Note fold window | **24 h** | publisher folds a note only when `staged_at` is within this window of the publication instant |
| Entry string clamp | **160 chars, single-line** | every clampable `entry.json` string (`summary_line`); structural fields carry their own tighter caps (§3.2) |
| Git probe budget | ~3 s / 1 MiB class caps per probe, sequential | §6 (the `source-snapshot.mjs` discipline) |
| Sweep bound | temps older than **10 min**, at most **8 removals** per run | §7.3 (own staging area only) |

## 5. Fingerprint

### 5.1 Algorithm

```
fingerprint = "fp1:" + sha256hex( canonical-JSON of
  {
    "branch":            <string|null>,
    "head_short":        <string|null>,
    "status_digest":     <string|null>,
    "session_id":        <string|null>,
    "note":              null | { "content_hash": <string>, "staged_at": <string> },
    "workflow_evidence": "none" | "fresh"
  } )
```

Canonical-JSON here means: the exact six keys above in the exact insertion
order shown, serialized by plain compact `JSON.stringify` (no whitespace
options), hashed over the UTF-8 bytes of that string, `null` for every
absent component. This is **not** the `canonicalJson()` helper in
`lib/schema-validate.mjs` — that helper pretty-prints with a trailing
newline for artifact writing and must never be reused as the fingerprint
encoding. The `fp1:` prefix names the input recipe; any change to the key
set, order, or serialization is `fp2:`.

**Settlement (b)** — the note component includes `staged_at` alongside
`content_hash`: re-staging identical text refreshes `staged_at` and
therefore republishes the slot. A content-hash-only component would pin the
old staging metadata in the slot until an unrelated field moved (the
plan-verify re-staging gap). Known bounded limit, accepted: `staged_at`
carries second precision, so re-staging identical content within the same
second (or across a clock rollback inside the §4 skew bound) may coalesce
into one generation — the next state change republishes; no staging nonce
is added for this.

### 5.2 Sensitivity (normative)

A republication MUST occur when any of these change: branch, head, status
digest, session id, note content, note staging instant, workflow evidence.
Identical-state turns MUST no-op within the refresh TTL. The no-op decision
reads the committed `entry.json` **only** (§7).

### 5.3 Evidence, not suppression

`repo_recent_terminal_evidence` is repo-level, last-observed evidence
relayed by the sensor. The publisher **never suppresses on it** — the
projection schema carries no session identity, so it can neither prove this
session is in-workflow nor prove it is not (ADR-0044 Alternatives J). It is
recorded; entry-side arbitration (ADR-0045) weighs it.

## 6. Git observation

Bounded sequential subprocess probes (the `source-snapshot.mjs`
discipline), each under the §4 budget, on the publisher's hot path:

- repo root: `git rev-parse --show-toplevel`; failure ⇒ silent no-op
  (non-git cwd produces nothing).
- branch: `git branch --show-current`; detached HEAD ⇒ `branch: null`.
- head: short form; unborn HEAD ⇒ `head_short: null`.
- status digest: sha256 hex over `git status --porcelain=v1 -z` output;
  output beyond the probe byte cap, or a probe error ⇒ `status_digest:
  null` AND `dirty_count: null` — **unknown, never clean**.

Degradation is per-field and honest: a failed probe nulls its own fields
and the capture still publishes (the remaining structure is the value).

## 7. Atomicity and the commit record

### 7.1 Per-file atomicity

Each file is written to a uniquely named sibling temp (§2 naming),
validated against its schema, then `rename`d into place. Per-file
atomicity is what the filesystem gives; no primitive makes two
replacements one transaction.

### 7.2 The commit record

Publication order is **`slot.json` first, then `entry.json`**, both
carrying the same `fingerprint`. `entry.json` is the **commit record**:

- The §5.1 refresh no-op decision reads the committed `entry.json` —
  never the possibly-newer `slot.json`.
- A fingerprint mismatch between the two files marks an **incomplete
  generation** that forces republication on the next publisher run
  (self-healing within one turn) instead of being pinned by a young-slot
  no-op.
- Testable invariant: *a mixed generation is never load-bearing and never
  survives the next publisher run.*

### 7.3 Sweep

The publisher sweeps **only its own staging area**
(`state/runtime/session-capture/`), only files matching the §2 temp
pattern, only entries older than the maximum writer lifetime (§4: 10 min),
bounded per run (§4: 8 removals). Deletion authority is the narrow
ADR-0044 §3 grant (own lock, temp/staging, and expired-claim files);
no other deletion is authorized. A no-op publication still performs the
bounded sweep.

## 8. Concurrency

- Concurrent publishers serialize through `.lock`, created `O_EXCL` with an
  owner token (`<pid>:<random-hex>`, written as the lock's content),
  released in `finally` **only when the stored token still matches** —
  a token-checked release, so a displaced owner cannot delete a
  successor's lock. A losing/locked-out publisher exits silently (another
  publisher is doing the work this turn). Age comparisons are strict
  (`age > stale-age`), with the §4 future-skew bound applied first.
- Stale-lock takeover: a lock older than the §4 stale-age (with the
  future-skew bound applied to its timestamp) may be taken over; the
  takeover rewrites the owner token so the displaced owner's release
  becomes a no-op.
- Across concurrent sessions of one repo the slot is **last-writer-wins**
  (the ADR-0043 slot concession). Producers never delete on read; consumers
  are strictly read-only on all three files.

## 9. Config-off and rollback semantics

Setting `session_capture = "off"` stops production; existing artifacts
remain on disk and readable — consumers arbitrate their staleness like any
other slot state. Removing them is an operator action: the rollback
runbook's one-shot cleanup is removing
`.agentic-plugins/state/runtime/session-capture/` entirely (ADR-0044 §10,
the ADR-0043 one-shot-cleanup shape), which prevents a stale staged note
from silently resurfacing after a re-upgrade. Rollback order is
consumer-first: ADR-0045 surfaces (when they exist) → `session_capture =
"off"` → attention sensor → runtime.

The half-enabled states between "off" and a working chain — key on but
attention missing/disabled, key on but the installed runtime below the
declared publisher floor (§13), safe mode disabling hooks entirely — are
surfaced by the `runtime:doctor` / `runtime:settings` readiness diagnosis
(ADR-0044 §3): the diagnosis and the publisher gate read the same
`loadSessionConfig` loader, so they can never disagree about what "on"
means.

## 10. Consumer rules

- The entry side reads **`entry.json` only** — never `slot.json`, never
  `note.json`; pointers presented to a session target the validated
  `entry.json` file, never the capture directory.
- Read-only, no consumption: the slot is a durable, last-writer-wins
  advisory, not a one-shot. No consumer deletes, marks, or rewrites any of
  the three files; a consumed-marker, if ever needed, is a **new sibling
  artifact owned by the consumer** through its own ADR-0035 §5 add-gate.
- Staleness is recomputed by the consumer from `captured_at` /
  `note_staged_at` under the §4 future-skew bound.
- `summary_line` (and any note content) is **untrusted quoted data** —
  never instructions, never a command source. Clamping bounds the channel;
  it does not make the content safe.

## 11. Test obligations

S2 (this slice) — all mutation-verified:

- `session` family: valid `off`/`stop-hook` accepted, any other value
  rejected; shipped default `off`; `session_capture` present in
  `CONFIG_KEYS`; settings plan/report/help carry the family.
- `loadSessionConfig`: repo overrides user overrides default; unreadable
  layer fail-closes; invalid effective value fail-closes; notify loader
  behavior unchanged on the shared core.
- Schemas: each of the three families loads through `loadSchema`, accepts
  a canonical-valid document, and rejects mutations (unknown key, wrong
  type, multi-line where single-line is required, bad schema id).
- This document is pinned **by content** (the machine-bootstrap-contract
  §11.3 precedent) in `tests/plugin-shape/test-runtime-plugin.mjs`.

S3a/S3b (the executor slices) add: gate-off default no-op; commit-record
no-op; mixed-generation forced republish; lock contention/takeover/skew
with token-checked release; fingerprint sensitivity per §5.2 **with exact
digest vectors** (no-note, Unicode note content, identical content
re-staged with refreshed metadata — each proving the fingerprint moves);
the **semantic invariants structural JSON Schema cannot express** — these
are executor-validator obligations, not schema obligations:
`summary_source = structural` ⇔ `note`/`summary_line`/`note_staged_at` all
null, `dirty_count` a non-negative integer when non-null, `content_hash`
matching the exact content bytes, and slot/entry `fingerprint` equality
within a committed generation; injection clamps; hostile-path and
`note --file` FIFO/oversize/symlink rejection; non-git no-op;
capture-before-notification ordering (attention side, S5).

S4 (the readiness slice) adds, all mutation-verified: shared readiness
assessment — gate off ⇒ informational `off` (never a warning); config
fail-closed ⇒ `config-fail-closed`; each §13 half-enabled state detected
independently and composably (safe mode + missing attention both reported);
floor-declaration absence vs malformation distinguished; a below-floor
runtime detected against an injected declaration; ready-state control case
proving the blockers are reachable; settings `session_readiness` section
shape + `section_presence` row in both report scopes + text token + overall
counter; doctor `session_capture` section shape + text token + overall
warning on blocked (and silence on `off`/`ready`).

## 12. Non-goals (v1)

- No Codex firing point — Claude limb only (ADR-0044 §8); artifacts stay
  host-neutral and CLI participation works from either host.
- No transcript mining, ever, on this surface (ADR-0044 Alternatives E).
- No per-event run ledger for the auto path (Alternatives F) and no
  PreCompact binding (Alternatives G — a ≤1-turn window).
- No machine-global home; no host-config writes; no host-session mutation.

## 13. Publisher-floor declaration and the readiness diagnosis

ADR-0044 §2 gives the publisher spawn its **own capability floor**,
separate from the notify floor (`MIN_RUNTIME_VERSION` in
`plugins/attention/scripts/discover-runtime.mjs`) — "the two gates never
share a constant" — and the §10 rollout order means the floor can only be
pinned **after** the runtime release carrying `publish-session` exists.
The runtime-side readiness diagnosis therefore never hardcodes an
attention constant; it reads a **declaration file** the attention plugin
ships:

```
<attention plugin root>/data/runtime-floors.json
```

```json
{
  "schema": "attention-runtime-floors-1.0",
  "floors": {
    "publish_session": "<first released runtime version shipping publish-session>"
  }
}
```

- **Producer (attention, S5)**: ships the file in the same release that
  adds the capture spawn to the Stop sensor, with `floors.publish_session`
  pinned to the first **released** runtime version carrying
  `publish-session` (the ADR-0043 released-floor rule — a
  planned-but-unreleased version is never pinned, and the declared floor
  is a plain `X.Y.Z` release version: a prerelease or build-suffixed floor
  is malformed by definition). The sensor's own spawn
  gate and this declaration must agree byte-for-byte on the floor. Future
  sensor-fed executors add sibling keys under `floors` (additive; the
  schema id bumps `1.<minor>` per the §3 versioning posture — but unlike
  the slot/entry/note schemas this file crosses plugin versions by design,
  so consumers accept any `attention-runtime-floors-1.*` id and read only
  the keys they know).
- **Consumer (runtime readiness diagnosis, S4)**: discovers the newest
  installed attention build (Claude cache scan — the v1 firing point is
  Claude-only per §12, so the Claude cache is the load-bearing install),
  then reads the declaration dynamically:
  - attention not installed ⇒ state `attention-missing`;
  - installed but host reports it disabled ⇒ `attention-disabled`
    (enablement is host-CLI evidence; filesystem-only callers report it
    `unverified`, never guessed);
  - installed but no declaration file ⇒ `publisher-sensor-not-shipped`
    (the installed attention build predates the capture sensor — the
    honest pre-S5 state on every machine);
  - declaration unreadable/malformed ⇒ `floor-declaration-malformed`
    (fail-closed: never treated as satisfied);
  - declared floor newer than the installed runtime ⇒
    `runtime-below-publisher-floor`;
  - safe mode (`CLAUDE_CODE_SAFE_MODE`, `host-parity-baseline.md` hooks
    row) disables the whole hook chain ⇒ `safe-mode-hooks-disabled`.
- States compose (a machine can be in safe mode **and** below floor);
  the diagnosis reports all of them, plus a single overall status:
  `off` (gate off — informational, not a warning), `ready`,
  `blocked` (gate on, one or more states above), or `config-fail-closed`
  (the shared loader refused — same refusal the publisher makes, §1).
- **Stated limits**: the floor comparison uses the runtime version
  executing the diagnosis; the sensor resolves its own runtime through
  attention's discovery ladder (env override, cache, sibling), so a
  machine running the diagnosis from a source checkout or an overridden
  root can differ from the sensor's selection — the diagnosis is
  advisory, not a re-implementation of the sensor's ladder. Enablement is
  a host-CLI evidence injection: when the caller's plugin-list evidence
  names the active version, the declaration is read from that build's
  cache directory; otherwise the newest cached build is read.
- The diagnosis is **read-only** and never repairs, deletes, or writes
  anything — it is the ADR-0044 §3 surface that makes a silently-broken
  "code-guaranteed" chain distinguishable from a working one.
