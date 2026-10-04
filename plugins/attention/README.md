# plugins/attention — hook-only Claude lifecycle sensors

Hook-only **Layer 1 framework primitive** per
[ADR-0040 §3](../../docs/adr/0040-operator-observability.md), amended by
[ADR-0044 §2](../../docs/adr/0044-session-generic-handoff-capture.md) and
[ADR-0045 §2](../../docs/adr/0045-entry-time-proposal-surfaces.md) into
**host-lifecycle sensors feeding allowlisted runtime-owned executors**:
`context.mjs publish-session` (the session-capture publisher) and
`context.mjs entry-brief` (the R0 entry arbiter). It ships
**hooks + sensor scripts only** — no skills, no verbs, no state machinery —
the hook-bearing sibling of the
[ADR-0008](../../docs/adr/0008-companion-distribution-model.md)
script-only library shape, isolated in its own rarely-releasing plugin so the
hook review/trust burden never attaches to frequently-releasing packages
(ADR-0010 §6 Trigger 2).

Until [ADR-0064](../../docs/adr/0064-runtime-surface-reduction.md) Decision 1
the plugin also fed the runtime's notification emitter (`notify.mjs emit`)
from `Notification` and `SubagentStop` hooks and a notification stage in the
Stop hook. Those sensors, the Stop finality classifier, the event builders
and the notify and response-signal runtime floors were removed; the
`CHANGELOG.md` entry of the release that removed them is the record.

## What it registers (Claude Code, manifest-declared `adapters/claude/hooks/hooks.json`)

| Hook event | Matcher | Executor | Output |
|---|---|---|---|
| `Stop` | — (none exists) | `context.mjs publish-session` (ADR-0044 §2) | nothing (stdout-silent) |
| `SessionStart` | `startup` (explicit, `timeout: 15`) | `context.mjs entry-brief` (ADR-0045 §7) | at most one validated entry-brief line, or nothing |

### The Stop sensor's freshness gate

The capture spawn relays `--workflow-evidence fresh` **only** behind a
freshness-checked read of `last-session-handoff.json` (the ADR-0031/0039
sidecar projection), per persona — all four onboarded personas since the
ADR-0043 §3 follow-up (engineer, orchestrator, founder, designer):

1. **workflow-id + kind consistency** — the projection's `workflow_id` must
   match the `.footer-rendered` marker's, the marker must record
   `status: "rendered"` (a `claimed` marker is a render in flight, not a
   completed terminal presentation), and the projection's `workflow_kind`
   must strictly equal the persona (the canonical bounded schema requires
   the field — a malformed projection degrades, never counts);
2. **transition anchor** — both the projection's mtime AND the rendered
   marker's `at` timestamp (the render moment) must be recent
   (`HANDOFF_FRESHNESS_MS`, 10 minutes). The marker anchor is what ties the
   evidence to the terminal *transition*: founder/designer publish-needed
   workflows stay active-terminal with their Stop backstop refreshing the
   projection every turn, but the rendered `at` is written once per
   transition — so later turns relay no fresh evidence (a primary
   re-terminalization rewrites the marker and re-arms it);
3. **per-persona marker shape** — engineer, founder, and designer key
   `<projection>.footer-rendered`; orchestrator keys
   `<projection>.<workflow-id>.footer-rendered` (the shapes differ by
   design; founder and designer document theirs as a cross-package
   contract in their `session-handoff.md` runbooks per ADR-0043 §2, and
   the sensor copies engineer's and orchestrator's from their
   session-handoff scripts).

A stale or missing projection is simply not evidence: the capture still
runs, and the publisher records `none` — never a wrong workflow claim.

### The Stop sensor's session-capture spawn (ADR-0044 §2)

The Stop sensor collects its evidence (payload, repo root, the per-persona
projection reads above) and spawns the runtime's
`context.mjs publish-session` with fixed argv — `--repo-root` (resolved from
the **payload-carried** `cwd`), `--host claude`, a clamped optional
`--session-id`, and `--workflow-evidence fresh` only when the projection
read observed a fresh terminal projection (an absent flag is recorded as
`none` publisher-side). A payload without `cwd` (malformed or empty hook
input) captures nothing: an automatic write keyed off the process cwd could
replace a valid session generation with an anonymous one.

The sensor stays policy-free: the `session_capture` opt-in gate (shipped
default `off`), fingerprint no-op, lock, and atomic publication are all
evaluated inside the runtime publisher (ADR-0044 §3). Capture is
repo-scoped — a non-git `cwd` produces nothing.

**Two capability floors** (ADR-0044 §2 + ADR-0045 §12 — the gates never
share a constant): the capture spawn is gated at
`PUBLISH_SESSION_MIN_RUNTIME_VERSION` (`0.82.0`, the first **released**
runtime shipping `publish-session`, recorded by the ADR-0044 §Status S4a
release-proof gate), and the entry spawn at `ENTRY_BRIEF_MIN_RUNTIME_VERSION`
(`0.83.0`, the first **released** runtime shipping `entry-brief`, recorded by
the ADR-0045 §Status S8a release-proof gate). Below its own floor each spawn
skips silently while the other keeps working; when a floor passes but the
resolved runtime root lacks `scripts/context.mjs` (capability drift), that
spawn no-ops equally silently. The plugin ships the floors as a
**declaration file** for the runtime-side readiness diagnosis
(session-capture-contract §13 + §18; `entry_brief` is the §18 additive
sibling key — a floors file without it is the honest pre-entry-sensor state,
never malformed):

```
data/runtime-floors.json
  { "schema": "attention-runtime-floors-1.0",
    "floors": { "publish_session": "0.82.0", "entry_brief": "0.83.0" } }
```

Each spawn-gate constant and its declaration key must agree byte-for-byte —
`tests/plugin-shape/test-attention-plugin.mjs` pins the pairs, alongside the
plain-`X.Y.Z` released-floor rule. Prerelease semantics: the DECLARATION rule
is aligned on both sides (this file must carry clean released `X.Y.Z`
values, and the runtime-side diagnosis refuses anything else), and the GATE
comparators agree in strictness — the sensors' strict `versionGte` and the
runtime diagnosis's shared `semverCompare` (runtime `lib/semver.mjs`,
prerelease tie-break) both hold an equal-core prerelease
(`0.83.0-beta.1`) below the floor (the S9 runtime-owned follow-up, closed).
A prerelease-versioned runtime install still does not occur under
release-please (plain `X.Y.Z` only), so the case stays theoretical on both
sides.

### Stop hot-path budget (contract values)

The Stop hook's worst-case latency is a stated contract
(`scripts/lib/sensor.mjs`, test-pinned), not an accident of defaults:

| Constant | Value | Meaning |
|---|---|---|
| `PUBLISH_SESSION_TIMEOUT_MS` | 12 s | the capture spawn's slot — bounded git probes + local IO, no network |
| `STOP_HOT_PATH_BUDGET_MS` | 12 s | aggregate worst case: the capture spawn is the hook's only child, so the aggregate is its one slot |

A publisher that overruns its slot is killed — **SIGKILL**, mirroring the
entry-brief spawn's kill bound (SIGTERM is trappable: a trapped child would
ride past the slot to the host's own hook timeout) — and the capture is lost
— the ADR-0040 §7 fail-closed choice (never a blocked host; the previous
turn's slot remains the session handoff).

### The SessionStart entry sensor (ADR-0045 §7)

`adapters/claude/hooks/session-start.mjs` is the entry-brief rollout's one
hook surface: it resolves the repo root from the **payload-carried** cwd
(no process-cwd fallback — this surface injects into model context, so
malformed/empty hook input degrades to injecting nothing; non-git cwd ⇒
silent no-op), shells the runtime's `context.mjs entry-brief` with fixed
argv (`--repo-root <resolved> --host claude --surface session-start-hook`),
and relays **at most one marker-paired line**
(`[agentic-entry-brief] {…} [/agentic-entry-brief]`) into model context via
the hook's documented stdout channel. Discovery is **capability-neutral**
(`resolveNewestRuntimePluginRoot`: manifest identity, no capability-file
filter), then the entry floor and the executor-existence probe gate that ONE newest
root with no re-descent to an older build — the exact dispatcher shape the
§18 readiness diagnosis mirrors. Every arbitration/precedence/gate decision
is arbiter-side (ADR-0045 §1); the user-scope-only `entry_brief` key
(default `off`) is evaluated inside the executor, so the sensor stays
policy-free — the gate-off spawn is the accepted cost shape
(session-capture-contract §15.3: 1 git spawn + 2 config reads, zero state
reads).

This sensor is the **scoped ADR-0040 §2.2 sensor-output exception**: stdout
carries exactly the one brief line or nothing; the Stop sensor remains
stdout-silent by the original invariant. The relay sits behind a
**validation boundary** (`sensor.mjs validateEntryBriefStdout`, dispatched
by `spawnEntryBrief`):

- **bounded buffer** — `spawnSync` `maxBuffer` 64 KiB; overflow kills the
  child and suppresses;
- **successful child exit** — no spawn error, no signal, exit status 0 (a
  conforming hook-grade executor exits 0 even for its no-line
  dispositions); the kill signal is **SIGKILL** (SIGTERM is trappable — a
  misbehaving child could otherwise ride to the host hook timeout);
- **exactly one marker-paired line** — one trailing LF permitted, nothing
  before or after, each marker occurring exactly once; empty stdout is the
  normal gate-off no-op;
- **a schema-declaring JSON payload** — the wrapped content must parse as
  a plain JSON object with `schema: "runtime-entry-brief-1.0"`, so a
  nonconforming executor cannot turn the relay into an arbitrary
  context-injection channel;
- **no extra output, no control characters (incl. U+2028/U+2029/U+FFFD),
  byte-capped** — a line over the contract's 4096-byte hook-line cap, a
  control character, or any second line is suppressed, never trimmed and
  never relayed.

The marker requirement doubles as the `"continue": false` defense: a
marker-paired line can never parse as a bare JSON hook response, so the
sensor cannot be steered into the one structured output that halts Claude
entirely (probed matrix, failure-isolation row); a marker-*wrapped*
`{"continue": false}` is inert data and additionally fails the schema
check.

**Probe gate** (ADR-0045 §7/§12, S9 gate policy): the registration shipped on a
probed SessionStart matrix — `matcher: "startup"` fires exactly once per fresh
session, injects stdout into context, is non-blocking on failure, and honors
the explicit per-hook `timeout` (seconds). Probed PASS on `2.1.214`
(2026-07-18), re-validated live on `2.1.215` (2026-07-20). That matrix, and the
version-bound re-validation that kept the gate current, lived in
`plugins/runtime/docs/host-parity-baseline.md`, which
[ADR-0060](../../docs/adr/0060-remove-host-version-tracking.md) deleted
(§Decision 2). The gate is therefore no longer re-checked: the hook stays
registered, and a host change that breaks one of those behaviours is
discovered when the entry brief stops arriving, not before.

### SessionStart budget (contract values)

Synchronous SessionStart handlers delay session entry until they finish
(probed matrix), so the entry sensor's latency is a stated contract
(`scripts/lib/sensor.mjs`, test-pinned):

| Constant | Value | Meaning |
|---|---|---|
| `ENTRY_BRIEF_TIMEOUT_MS` | 12 s | the executor spawn's **kill bound** (SIGKILL), not a completion guarantee — the runtime's ≤5 sequential bounded git probes can theoretically sum past it, in which regime the spawn is killed and the brief lost; the typical warm-cache path completes in milliseconds |
| `SESSION_START_HOOK_TIMEOUT_S` | 15 s | the explicit per-hook `timeout` registered in hooks.json (seconds — the Claude unit); host-enforced ceiling over node startup + discovery + the spawn |
| `SESSION_START_BUDGET_MS` | 15 s | aggregate worst case: attention registers exactly ONE SessionStart hook, so the aggregate equals that hook's host-enforced timeout |

An executor that overruns its slot is killed and the brief line is lost —
the ADR-0040 §7 fail-closed choice (never a delayed session entry beyond
the budget; the operator still has the CLI and dashboard surfaces).

**Rollback** (ADR-0045 §12, consumer-first): set `entry_brief = "off"` in
the **user-global** config — and clear any `AGENTIC_ENTRY_BRIEF` /
`AGENTIC_ENTRY_BRIEF_EMPTY` environment values first, since env outranks
user config and a lingering `startup` env value keeps the line firing —
then remove/release the attention sensor, verify no firing, and remove the
runtime surface last. The entry side is R0: no durable entry-side
artifacts exist to clean.

## How the sensors reach the runtime

Both sensors resolve the runtime plugin root through a copied
`scripts/discover-runtime.mjs` (ADR-0039 §5 ladder with ADR-0061 §Decision 3's
candidates: `AGENTIC_RUNTIME_ROOT` env override → the versioned install cache
of the host attention runs from → the other host's cache only when that host
has no runtime installed, reported on stderr → sibling monorepo only when
attention runs from a checkout; never the Codex marketplace clone). The
ladder identifies the runtime by its manifest, with no capability-file
filter, and resolves ONE newest root; each sensor then gates that root on
its own floor (capture ≥ 0.82.0, entry brief ≥ 0.83.0) and executor probe,
with no fall-back to an older cached build. A missing or too-old runtime is
a silent no-op. The capture spawn discards the publisher's output; the
SessionStart entry spawn, uniquely, captures the executor's stdout through
the validation boundary.

**Capture is off by default**: the runtime ships `session_capture = "off"`;
opt in via `runtime:settings`. **The entry brief is equally off by
default**: the user-scope-only `entry_brief` key ships `off` (a tracked repo
value can never enable it); opt in via `runtime:settings --entry-brief
startup`, diagnosed by the §18 `entry_readiness` section in settings/doctor.

## Invariants (ADR-0040 §7)

- **Fail-closed silent everywhere**: sensors exit 0 always, never write
  stdout (hook stdout is a decision channel), and degrade to no-op on any
  failure — a capture failure must never break a workflow, commit, or hook.
  The ONE scoped exception is the ADR-0045 §2.2 entry sensor, whose single
  validated marker-paired stdout line is its deliberate output channel; it
  emits nothing else, never a structured hook response, and stays
  exit-0-always.
- **Observers, not actors**: no Stop `decision` output, no host-session
  mutation, no persona-Stop ordering assumption (Claude fires all plugins'
  Stop hooks without ordering guarantees). The capture spawn relays
  observations only — every policy decision (opt-in gate, fingerprint,
  lock) is publisher-side (ADR-0044 §3).
- **Copy-not-import** (ADR-0010 §5): attention imports no runtime module.
  The discovery ladder, the strict floor gate and the `semverCompare`
  comparator are deliberate copies (the last one test-pinned byte-for-byte
  against runtime `lib/semver.mjs`); the executors are reached only by
  subprocess.

## Codex CLI

The plugin contributes **zero plugin-owned Codex hook surface**, by both
discovery inputs current Codex actually uses (host truth, Codex 0.144.1 —
recorded in the ADR-0040 §3 amendment):

1. `.codex-plugin/plugin.json` declares **no `hooks` key**, and
2. there is **no root `hooks/hooks.json`** — Codex's default-file discovery
   loads that location regardless of command shape, which is exactly why the
   Claude registration is manifest-scoped at
   `adapters/claude/hooks/hooks.json` instead of the default path.

Non-declaration alone does NOT keep a default-location hooks file out of the
Codex `/hooks` review/trust surface; path isolation does. The `skills/`
directory remains the Codex manifest-spec placeholder per the ADR-0008
carve-out. The capture firing point and the entry hook surface are
Claude-only at v1 (ADR-0044 §8 / ADR-0045 §10 — Codex gets the symmetric
CLI + dashboard surfaces).

## Layout

```
plugins/attention/
├── .claude-plugin/plugin.json     # Claude manifest ("hooks" → adapters path)
├── .codex-plugin/plugin.json      # Codex manifest (no hooks key)
├── adapters/claude/hooks/         # Claude adapter surface (host-specific)
│   ├── hooks.json                 # hook registration (manifest-declared;
│   │                              #   NOT at the Codex default-discovery path)
│   ├── stop.mjs                   # ADR-0044 §2 capture sensor (freshness-checked
│   │                              #   workflow evidence → publish-session)
│   └── session-start.mjs          # ADR-0045 §7 entry sensor (startup matcher,
│                                  #   validated single-line stdout relay)
├── data/
│   └── runtime-floors.json        # §13+§18 floor declarations (byte-for-byte
│                                  #   with the sensor spawn gates; test-pinned)
├── scripts/
│   ├── discover-runtime.mjs       # ADR-0039 §5 ladder copy (manifest identity)
│   │                              #   + publish-session ≥ 0.82.0 and entry-brief
│   │                              #   ≥ 0.83.0 floors
│   └── lib/sensor.mjs             # freshness gate + capture spawn seam +
│                                  #   entry-brief dispatch seam (validation
│                                  #   boundary) + budget values
└── skills/README.md               # Codex manifest-spec placeholder (ADR-0008 carve-out)
```
