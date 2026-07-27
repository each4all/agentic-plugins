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
| `observed` | only where the doctor artifact still exists | proof run id, artifact hash, installed state |
| `operator-attested` | never | `install_method`, `proofs[].command` |
| `authored` | never | `narrative`, `relations[]`, and **membership of every array** |

Two consequences are easy to get wrong, so they are stated here as well as in
the schema:

- **`proofs[].command` is attested, not observed.** The doctor artifact does
  not persist an invocation. What the record carries is the operator's
  normalized recipe.
- **Array membership is authored.** Which releases, commits, or proofs belong
  to a loop is an editorial judgment — the loop boundary itself is. Each
  *entry's* fields are checked; the array's *completeness* is not, because no
  source states what it should contain.

## What the validator checks

**Derived.** Tag resolves; `squash` is the tagged commit; `version` matches
`.release-please-manifest.json` **as it stood at the cited tag**; `package` and
`tag` agree via the release configuration at that tag (necessary because two
packages' tags can sit on one commit); the marketplace sync is a descendant of
the release with no intervening release and a catalog-sync subject; every
commit sha resolves *and* is reachable from the integration branch.

**PR numbers** are derived only when the commit subject carries `(#N)`.
Otherwise use the `*_attested` sibling — and using it when the subject *does*
carry the number is a failure, so attestation cannot step around a check that
would have run.

**Observed.** The artifact hash is compared over the exact bytes on disk when
the artifact is present. Absent is reported `unverified`, never green-by-
default: `.agentic-plugins/runs/` is gitignored and retention-pruned, so CI has
no artifacts. Present-but-unreadable or mismatched **fails**.

**Structure.** Filename/`record_id` agreement, id uniqueness, duplicate release
tags / proof run ids / commit shas within a record, one owning record per
release tag, no self-referencing relation, and no relation to a record that
does not exist.

A shallow clone **fails** rather than skipping — a git-backed check that
no-ops reads as coverage.

## Authoring

A record cannot be written inside the implementation PR of the loop it
describes: its tag, squash, marketplace-sync sha, proof run id and artifact
hash come into existence only after that PR merges, release-please cuts the
release, the catalog sync lands, the hosts are updated, and a doctor run is
recorded. Authoring is a **post-release step**, in the position the recurring
recovery PR already occupies.

Relations may only target records in this store. Loops that predate it are not
addressable until the migration ADR that Decision 6 defers.
