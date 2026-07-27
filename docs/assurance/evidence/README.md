# Evidence store

Machine-checkable records of the facts that back this repository's assurance
claims. Decided by [ADR-0049](../../adr/0049-evidence-as-data.md), as amended
2026-07-27.

```
docs/assurance/evidence/
├── README.md
├── schema/evidence-record-1.0.json    # closed schema; every property declares its provenance
└── records/<record_id>.json           # one record per EVIDENCE LOOP
```

Validate with `npm run validate:evidence-store`.

## What a record is

One record per **evidence loop**, not per release. A loop may span several
releases — `0.86.0`/`0.86.1`/`0.86.2` are one loop — and a single day may carry
several loops. `record_id` is the key and must equal the filename stem.

## Provenance is the point

Every property carries exactly one `x-provenance` class, and that declaration
is what tells a gate whether it may assert the field:

| class | checked? | examples |
|---|---|---|
| `derived` | yes, everywhere including CI | release tag, squash, version at the cited tag, commit shas |
| `observed` | only where the doctor artifact still exists | proof run id, date, runtime version, artifact hash, installed state |
| `operator-attested` | never | `install_method`, `proofs[].command`, the `*_attested` PR siblings |
| `authored` | never | `narrative`, `relations[]`, and **membership of the per-loop arrays** |

The declaration is not decoration — the checker dispatches on it. Every
`observed` field must be either extractable from the doctor artifact or listed
as pointer-only in `scripts/lib/evidence-store.mjs`; one that is neither fails
the gate. Relabelling a field is therefore a change the gate notices.

Three consequences are easy to get wrong, so they are stated here as well as in
the schema:

- **`proofs[].command` is attested, not observed.** The doctor artifact does
  not persist an invocation. What the record carries is the operator's
  normalized recipe — which is not even the literal invocation, since the
  recipe omits the `--record` that causes an artifact to exist and the
  `--repo-root` the wrapper supplies.
- **Per-loop array membership is authored.** Which releases, commits, or proofs
  belong to a loop is an editorial judgment — the loop boundary itself is. Each
  *entry's* fields are checked; the array's *completeness* is not, because no
  source states what it should contain. The rule covers the arrays hanging off
  the record root; an array nested inside an entry (a proof's `readings`) is
  not a membership question and carries its own class.
- **A release may appear in more than one record.** ADR-0049 Context
  constraint 1 records four records on a single day. Duplicate rejection is
  therefore *within* a record, where it means an authoring slip.

## What the validator checks

**Derived.** The tag exists **in `refs/tags/`** — resolving the bare name would
also accept a branch of that name standing in for a deleted tag; `squash` is
the tagged commit; `version` matches `.release-please-manifest.json` **as it
stood at the cited tag**; `package` and `tag` agree via the release
configuration at that tag, which is necessary because two packages' tags can
sit on one commit (`plugin-runtime-v0.83.0` and `plugin-attention-v0.6.0` are
both `e249ac7c`); the marketplace sync is reachable from the integration
branch, a descendant of the release, has no intervening release, and carries a
catalog-sync subject; every commit sha resolves *and* is reachable from the
integration branch. A missing tag, config, or key **fails closed**.

**PR numbers** are derived only when the commit subject carries `(#N)`.
Otherwise use the `*_attested` sibling. Three ways around that are closed:
using the attested field when the subject *does* carry the number, setting both,
and omitting both when the number is derivable.

**A null `marketplace_sync` is a claim, not an absence** — if a catalog-sync
commit sits in the release's window, the claim fails. Omission is not a way
around the relation check.

**Observed.** The artifact hash is compared over the exact bytes on disk when
the artifact is present, and the fields the artifact can answer for (`run_id`,
`date`, `runtime_version`) are compared against it — the hash pins the bytes,
not the transcription. `installed`, `host_cli` and `readings` are pointer-only:
the artifact has no single counterpart for them, so they rest on the run id and
hash, which is the assurance level Decision 4 claims. Absent is reported
`unverified`, never green-by-default, because `.agentic-plugins/runs/` is
gitignored and retention-pruned so CI has no artifacts. Mismatched, corrupt, or
present-but-unreadable **fails** — presence is decided by errno, not
`existsSync`, which cannot tell absence from an unreadable parent directory.

**Structure.** Filename/`record_id` agreement, id uniqueness across the store,
duplicate release tags / proof run ids / commit shas within a record, no
self-referencing relation, and no relation to a record that does not exist.

A shallow clone **fails** rather than skipping — a git-backed check that no-ops
reads as coverage — and that verdict is reached before any per-record early
exit, so a filename typo cannot hide it. An empty store is the one case that
returns before the history check: with no records there is nothing git-backed
to check.

## Authoring

A record cannot be written inside the implementation PR of the loop it
describes: its tag, squash, marketplace-sync sha, proof run id and artifact
hash come into existence only after that PR merges, release-please cuts the
release, the catalog sync lands, the hosts are updated, and a doctor run is
recorded. Authoring is a **post-release step**, in the position the recurring
recovery PR already occupies.

Relations may only target records in this store. Loops that predate it are not
addressable until the migration ADR that Decision 6 defers.
