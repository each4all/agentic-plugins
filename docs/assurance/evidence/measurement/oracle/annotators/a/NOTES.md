# Oracle annotation notes

## How I worked

I read `TASK.md` first, then read the complete measurement contract before looking at the registry, schema, manifest, seal carrier, or corpus. I derived both domains from the registry's whole-family recognition rules: the core `plugin-<package>-v<major>.<minor>.<patch>` token for `release-triple`, and every `<kind>-<YYYYMMDD>T<HHMMSS>Z-<lowercase hex>` token for `proof-date-binding`. I treated Markdown code delimiters as wrappers around a package-tag occurrence, not part of its span; the registry says the token may be “enclosed” by them, although it is less explicit about the span than the `pr-citation` rule.

Tooling found lexical candidates, computed UTF-8 byte offsets, checked manifest blobs and lengths, assembled manually selected identities, calculated digests, and verified the result. It did not decide whether an anchor made a claim or which role occurrence it bound to. I split the three stage documents into manual reading passes by relation and source section, read the surrounding prose for each anchor, recorded a disposition and sentence-specific provenance, and then reviewed the consolidated non-bound and hard cases. The policy declarations therefore use `class: "annotation"`, no tunable parameters, manual contextual adjudication, and an `ambiguous` tie policy, as required by contract §§4.2, 4.4, and 4.5.

For occurrence fields, authority-derived canonicals are `unresolved`. Proof-run artifact presence is `not-applicable` because this selected-blob clean-room delivery declares `artifact_only_scope: "out-of-scope"` under contract §2.3.

## Counts

| Relation | Domain anchors | Bound | Not a claim | Ambiguous | Incomplete |
|---|---:|---:|---:|---:|---:|
| `release-triple` | 145 | 123 | 6 | 0 | 16 |
| `proof-date-binding` | 292 | 163 | 115 | 10 | 4 |
| **Total** | **437** | **286** | **121** | **10** | **20** |

Judgment tags: **260 `lexical:`** and **177 `interpretive:`**. Every row begins with exactly one of those tags.

The domain counts surprised me mainly because repeated historical summaries and very long table cells produce many physically distinct occurrences of the same literal. I kept all of them because relation identity is occurrence-based under contract §§3.2 and 4.1. The whole-family domains also include package tags used only as hash-location labels and proof IDs used only as historical references; I doubt those mentions are useful positive measurements, but the registry deliberately includes them, so they receive `not-a-claim` rows rather than being omitted (§4.3).

## Hardest passages

The hardest proof passages used “same day” across long, nested release histories. A repeated date value is not enough: contract §§3.2 and 4.4 require one physical occurrence. The clearest example is `settings-20260808T065145Z-c8409f` at scorecard byte 38938. It sits between two doctor runs that the sentence calls same-day, and each doctor has its own distinct `2026-08-08Z` span. The attestation is dated in meaning, but the prose does not choose which physical date occurrence fills the role, so I marked it `ambiguous`.

Nested modifier scope was also difficult. Several settings attestations appear inside parentheses governed by a date that directly modifies a doctor record. I did not automatically propagate the doctor's date to every nested run ID. Full timestamps created a different edge: `2026-07-12T01:51Z` explicitly dates a settings attestation, but the registry's iso-date right boundary excludes the date substring because it is followed by the word character `T`; those claims are `incomplete`, not silently rebound to a nearby same-valued date (§§3.4 and 4.3).

For releases, condensed histories sometimes list one release PR, several package tags, and one marketplace sync. I bound the tags only after reading the clause's shared scope. I left commits called a `merge` out of the optional `squash` role, and treated an unlabeled trailing `sync` as `marketplace_sync` only where the release-history clause made that intent clear; those rows are `interpretive:`. Passages that explicitly say a package shipped but name no release PR are `incomplete` under §4.3.

## Ambiguous rows and adjudication questions

All 10 ambiguous rows are in `proof-date-binding`:

- Scorecard byte 38938, `settings-20260808T065145Z-c8409f`: two distinct bracketing `2026-08-08Z` occurrences are equally plausible. Resolution: identify which of the two physical date spans the attestation is meant to use, or give it its own adjacent date.
- Scorecard byte 84461, `settings-20260713T030937Z-f50815`: “same-day” directly modifies the enclosing doctor record, while the settings attestation is nested in parentheses. Resolution: state whether the date modifier also scopes over the attestation.
- Scorecard byte 86612, `settings-20260710T153728Z-5796b6`: `2026-07-10Z` directly dates the doctor proof containing this attestation. Resolution: state whether the enclosing date is also asserted for the nested settings run.
- Scorecard byte 107588, `doctor-20260803T033236Z-f56d25`: one date directly introduces the post-attestation proof and then mentions this earlier install proof. Resolution: say whether the single date occurrence applies to both proof IDs or only the first.
- Scorecard bytes 118350 and 118446, `settings-20260720T151554Z-3b543f` and `doctor-20260720T151637Z-e2e061`: “landed the same day” dates both actions, but two distinct `2026-07-20` spans are plausible role occurrences. Resolution: select the intended physical span or repeat the date beside each run.
- Scorecard byte 124379, `doctor-20260710T044745Z-1a789e`: the text says a same-day refresh followed this record, but the only explicit `2026-07-10Z` directly dates a different record. Resolution: state whether this anchor itself inherits that date.
- `DEVELOPMENT.md` bytes 94260, 94426, and 94494: `doctor-20260710T044745Z-1a789e` and its two compat runs are covered by a same-day closure clause, while both a `2026-07-10` baseline span and a separate `2026-07-10Z` record span are plausible physical bindings. Resolution: name the intended date occurrence, or put one explicit date next to the closure sequence.

## Verification

I wrote and ran two dependency-free Node 24 checks. The primary check validates every assertion keyword used by the sealed schema, enumerates the lexical domains independently from the artifact rows, checks role/disposition consistency, and verifies every named identity against the manifest bytes. The second check independently rejects duplicate JSON property names, uses fatal UTF-8 decoding, and repeats schema, seal, digest, membership, and role checks.

Both checks passed:

- Schema: valid against `artifact-schema.json`; `role` is `oracle`, required keys are present, and no additional keys were found.
- Domain totality: exactly 145 `release-triple` anchors and 292 `proof-date-binding` anchors; 437 unique relation/anchor keys, no duplicates, no omissions, and no out-of-domain rows (§§4.1 and 4.3).
- Spans: 821 unique family/identity occurrences support all anchors and filled roles. Every half-open range is within its manifest blob, every span decodes as fatal UTF-8 to its reported literal, every named identity has the declared family, and there were zero round-trip failures (§§3.2 and 3.5).
- Membership: all 77 delivered corpus files matched manifest byte lengths and Git blob identities; all relation occurrences are in the three `stage-docs` members (§2.1).
- Bundle digest (§11.3): `c7e68f04e450fa1e6fa7497fce3ca36e077e2f38fecc34605ee5d79e242c219f`, matching the recorded seal in `bundle-manifest.json`.
- Manifest digest (§2.1): `b2f1433af69131779bc1b2cc9e69f6a54709714e89145f9498a1c3959e6a7ebc`.
- Policy digests (§4.5): `release-triple` = `ae1c836d511d4192a205cd39be9a91f2428de8e2828e7c24685c0189c969ab77`; `proof-date-binding` = `ed102a0de1ed3958a9225f85ef275e7ee9adb4abf52bea28f5066b899ec32d22`.
- Artifact digest (§11.4): `4a1adb80a42f33b2e31d9e1503737a41f62d13f2bfb29265709ed1736d71efb4`, matching the attestation after canonical serialization with `attestation` removed.

## Outside-bundle access

External inputs read outside `bundle/` were:

- `TASK.md`, as the assignment required.
- `/Users/lmuffin/.codex/memories/MEMORY.md`, searched once by a structural helper because of a system-required memory pass. The search returned no relevant project content. I recorded this in `prohibited_inputs_accessed` rather than claiming an empty array.

No network, repository history, authority snapshot, comparator output, rationale-class association policy, construction inventory, other lane artifact, or other lane diagnostics were accessed.

The other outside-bundle files read were self-generated working derivatives of allowed inputs: `.anchor-inventory.tsv`, the JSON decision fragments under `work/`, `work/assemble-oracle.mjs`, `work/verify-oracle.mjs`, `/tmp/verify-evidence-artifact.mjs`, and its temporary builder/self-test files. They supplied no external corpus reading; they only preserved manual decisions or performed the mechanical checks described above.
