# ADR-0034: Codex `plugin list --json` as host-native installed-state read signal

## Status

Accepted

## Context

[ADR-0032](0032-codex-per-plugin-command-surface-adoption.md) made
`doctor` *recognize* the Codex `0.137.0` per-plugin command surface
(`codex plugin add/list/remove`) but deliberately deferred two
follow-ups, listing them as rejected-for-that-ADR Alternatives:

- **Option B** — use `codex plugin list --json` as a host-native
  installed-state read signal (this ADR);
- **Option C** — wire `codex plugin add` as an executor (still deferred,
  tied to the runtime non-mutating-boundary track).

Until now `doctor` read **Codex** installed-state only from filesystem
cache inspection (`~/.codex/plugins/cache/...` + the `.tmp/marketplaces`
snapshot), while the **Claude** side already used the host-native
`claude plugin list` read. That asymmetry meant a stale or missing Codex
cache directory could misreport installed-state, and a fresh install not
yet materialized into a per-plugin cache dir could read as absent.

Codex `0.137.0` confirmed (live) that `codex plugin list --json` returns
`{ installed: [ { name, marketplaceName, version, installed, enabled,
... } ] }`, on stdout, while emitting warnings on stderr. `--available`
additionally lists uninstalled marketplace inventory. Pre-`0.137` Codex
lacks the subcommand entirely.

This decision was reached through an `engineer:start` lifecycle with a
9-axis decision (ADR-0027) and two opposite-host Codex peer ensembles
(brainstorm + plan-verify). The plan-verify peer surfaced that
"authoritative" has consistency reach across many installed-state
consumers (see Decision §scope).

## Decision

`doctor` runs `codex plugin list --json` (read-only) as the
host-native Codex installed-state read signal, with
**list-authoritative-then-cache precedence**:

1. **Probe**: the codex CLI inspection gains a `plugin list --json`
   probe (`plugin_list` field). `--available` is **not** used — the
   `installed[]` array is the installed-state signal; mixing in
   uninstalled inventory would blur the diagnostic.
2. **Parse** (`parseCodexPluginList`): STDOUT only (a non-empty stderr
   must never downgrade a successful parse), filtered to
   `marketplaceName === 'agentic-plugins'`, sanitized to the readiness
   fields (name, marketplace, version, installed, enabled, status,
   install/auth policy) — **raw JSON and source filesystem paths are
   not retained**. Never throws: a missing subcommand, nonzero exit, or
   malformed JSON degrades to a status (`unsupported` / `unavailable` /
   `parse_error` / `malformed` / `empty`) that callers treat as
   "list unavailable".
3. **Resolve once** (`resolveCodexInstallState`): a single shared
   resolver computes the install decision so every doctor consumer reads
   the same answer. When the list probe succeeded, **the list is the
   source of truth** — `enabled` → installed, `installed && !enabled` →
   disabled (blocked), and a **list-confirmed absence means a stale
   filesystem cache must NOT claim an install the host list omits**. Only
   when the list probe was unavailable does the decision fall back to the
   existing cache logic (`decision: 'fallback'`).
4. **Consumers** (all within `doctor`): the plugin matrix
   (`installed.codex_plugin_list` + `installed.codex_resolved`), the
   coarse plugin status, the readiness-matrix codex `installed` row, the
   codex installed-version parity, and a new `codex_retired_or_unknown_plugin`
   host-parity note (mirroring Claude's) all use the resolver decision.
   Cache-based **materialization** stays cache-derived on purpose:
   "installed per the host list, but the per-plugin cache is not yet
   materialized" is a coherent, non-contradictory sub-state.
5. **Redaction**: only `plugin_list_command_status` (status/exit/error)
   is persisted in the recorded artifact; the raw `plugin list --json`
   stdout is never written.

**Stage-aware**: pre-`0.137` Codex (no subcommand) and any
nonzero/malformed result degrade to cache fallback, so existing behavior
and tests are unchanged on older hosts.

**Read-only boundary (ADR-0024)**: only `codex plugin list --json` is
invoked — never `add`/`remove`/`marketplace`-mutating commands, and not
`--available`. No host config or session is mutated.

### Scope

List-authority is applied **within `doctor`** this ADR. The cross-script
installed-state consumers — `settings.mjs` marketplace/materialization
recommendations, `cutover-audit.mjs` installed-version evidence, and
doctor proof-reuse comparison — remain **cache-based** for now and are an
explicit, tracked follow-up (see
[`follow-ups.md`](../../plugins/runtime/docs/follow-ups.md)). This honest
boundary (per the project's "honest scope" principle) keeps the change a
single deliverable rather than a sprawling cross-command migration; the
follow-up will route those consumers through the same resolver.

## Consequences

**Positive**

- Codex installed-state reaches Claude parity: host-native list read with
  cache fallback, not cache-only inference.
- A stale/leftover Codex cache directory can no longer falsely report an
  install the host list omits.
- One shared resolver means doctor's matrix status, readiness row, and
  version parity cannot disagree about Codex install state.

**Negative**

- During the cross-script follow-up window, `runtime:doctor` may report
  Codex installed-state from the list while `runtime:settings` /
  `runtime:cutover` still reason from cache. The boundary is documented
  here and in `follow-ups.md` rather than hidden.

**Neutral**

- The plugin matrix gains an additive `installed.codex_plugin_list` /
  `installed.codex_resolved`; the readiness-matrix shape is unchanged
  (only the codex `installed` evidence source/string changes). No schema
  bump was required (additive; no strict-key validator).

## Alternatives Considered

- **Amend ADR-0032 instead of a new ADR** (the brainstorm peer's pick):
  lighter, but this introduces a real installed-state **precedence
  policy** (host list authoritative over stale cache) worth a discoverable
  record, and ADR-0032 itself anticipated "a future ADR may add the read
  signal." A new ADR-0034 documents the policy; ADR-0032's Option B is
  marked realized here.
- **Full cross-script migration now** (settings + cutover + proof-reuse):
  most globally consistent, but spans multiple commands → multi-deliverable;
  deferred as a tracked follow-up to keep this a single PR.
- **Evidence-only (no precedence change)**: report the list as a new field
  without changing any verdict. Rejected: under-delivers the
  list-authoritative installed-state this ADR exists to provide.
- **Use `--available`**: rejected — it mixes installed and uninstalled
  marketplace inventory; catalog availability is already covered by
  marketplace/catalog/cache inspection.
