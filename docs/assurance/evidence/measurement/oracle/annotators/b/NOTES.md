# Oracle annotation notes — `stage-docs`, contract 2.2.0

Artifact: `out/oracle.json` (`role: "oracle"`, 437 anchor rows, 820 named occurrences).
Bundle seal `c7e68f04…`, manifest `b2f1433a…`, corpus commit `d49f74e6…`,
artifact digest `90739b9f…`.

---

## 1. How I worked

**Read first, in full:** `measurement-contract.md` (all 1178 lines),
`family-registry.json`, `corpus-manifest.json`, `artifact-schema.json`. The
contract is the specification I worked to; where a decision below is governed by
it, I cite the clause.

**Worked out the domain rather than assuming one.** Both declared relations bind
to the `stage-docs` profile (registry `relations[].profile`), and the manifest
enumerates that profile as exactly three files — `docs/ARCHITECTURE.md`,
`docs/DEVELOPMENT.md`, `docs/assurance/omcc-cutover-scorecard.md`, ~302 kB
total. `release-triple` anchors on the whole `package-tag` family
(`restriction: null`); `proof-date-binding` anchors on the whole `proof-run-id`
family. Applying the registry's two recognition rules to those three blobs gives
**145** package-tag anchors and **292** proof-run-id anchors. Nothing about that
count surprised me except its size: the registry's own note warns that
restricting the domain to "the one package a live gate happens to check" would
rebuild that gate's blind spot, and the price is visible here — 95 of the 145
tag anchors are `plugin-runtime`, and the other 50 are five other packages that
a runtime-only reading would have dropped.

**Tooling did the mechanical work, and only the mechanical work.** I wrote small
Node scripts to (a) enumerate lexical candidates for all five families under the
registry's rules, (b) render each anchor's surrounding prose with every nearby
candidate occurrence tagged inline with its byte offset, (c) convert character
positions to byte offsets, (d) assemble the JSON, and (e) verify the result. The
enumerator produced a *reading sheet*; it produced no disposition and no
binding.

**Then I read the corpus.** I read every byte of the three stage documents that
contains or surrounds an anchor — including `docs/DEVELOPMENT.md` line 466 (a
single 58 kB paragraph carrying 40 tag anchors and 79 run-id anchors) and the
scorecard's R3 table cell (lines 1288–1289, ~41 kB, 33 tag anchors and 76 run-id
anchors) — in ~6 kB passes, and decided each row against the sentence it sits
in. Every `provenance` string quotes or paraphrases the clause that decided it.

**Where I judged, versus where I read.** 227 rows are tagged `lexical:` and 210
`interpretive:`. The `lexical:` rows are ones where the document labels the roles
itself — "release PR [#704] squash `47bc9c9`, tag plugin-runtime-v0.91.0,
marketplace sync `361952c`" — and picking them is transcription. Everything else
is `interpretive:`, including **every** `not-a-claim`, `incomplete` and
`ambiguous` row, because deciding that a sentence mentions rather than claims is
reading intent by definition.

**Two annotation stances I fixed by reading the corpus, and applied per
instance.** Stating them here is not a rule I ran; it is what I found the
documents to be doing, and each row still names its own evidence.

- *release-triple.* The tag anchor makes the claim when the sentence is
  reporting the release event — "released as PR N … tag T … marketplace sync C",
  "release PR N cut tag T with marketplace sync commit C". It makes no claim
  when the tag is used to identify a version that carries a feature ("the
  founder and designer sidecar emitters shipped with `plugin-founder-v0.4.0`") or
  to name a place a hash matches ("the `plugin-runtime-v0.91.2` tag and the
  repository alike").
- *proof-date-binding.* The run-id anchor makes the claim when the text says
  when this run was recorded — "recorded on D as R", "R (D)", "the D R", "R on
  D". It makes no claim when the run is cited as an artifact, a ledger handle,
  an interval endpoint, an executor's output or an ordering reference, none of
  which state a date.

**Two things the corpus punished, and I did not let the tooling decide.**
The registry flags that `squash` and `marketplace_sync` share the
`commit-citation` family, so family membership cannot say which role a commit
fills. In this corpus the release sentences routinely carry **four** commit
citations — an implementation squash, a release squash, a marketplace sync and a
*stage-doc sync* that fills no declared role — and in several the implementation
PR's squash is printed immediately before the release PR's. `release PR #695
squash 271c5ae` versus `implementation PR #694 squash aaf4744` is one label
apart and one occurrence apart; anything positional gets it wrong. Every such
row was picked off the label.

## 2. Per relation

| Relation | Anchors in domain | `bound` | `not-a-claim` | `incomplete` | `ambiguous` |
|---|---|---|---|---|---|
| `release-triple` (package-tag / stage-docs / no restriction) | 145 | 122 | 14 | 8 | 1 |
| `proof-date-binding` (proof-run-id / stage-docs / no restriction) | 292 | 142 | 129 | 5 | 16 |

Judgment tags: `release-triple` 106 lexical / 39 interpretive;
`proof-date-binding` 121 lexical / 171 interpretive. Overall **227 lexical /
210 interpretive**.

Named occurrences by family: package-tag 145, proof-run-id 292,
commit-citation 171, iso-date 122, pr-citation 90.

## 3. The passages I found hardest

**(a) The same tag or run twice in one paragraph, once claiming and once not.**
`docs/DEVELOPMENT.md` carries `plugin-runtime-v0.91.2` at byte 40247 inside
"released as PR [#717] squash `95e5b04`, tag `plugin-runtime-v0.91.2`,
marketplace sync `b92cc1d`" — `bound` — and again at byte 41075 inside "the
packaged baseline hashes `86fdf17e…` in the Claude cache, the Codex cache, the
`plugin-runtime-v0.91.2` tag and the repository alike" — `not-a-claim`. Same
literal, same file, 828 bytes apart, opposite dispositions. This is exactly
§3.2's point that value agreement is not occurrence agreement, and it recurs
four more times in the scorecard (@91716, @94658, @98702, @101252).

**(b) "merge" where the role is called `squash`.** Release PR #616 is written
"`chore: release main` merge `c2bc0f9`" — the document distinguishes merges from
squashes deliberately, because ADR-0016 routes multi-package releases as
rebase-merges. I bound `c2bc0f9` to `squash` on all four occurrences of that
release, reading the role as "the commit the release PR landed as" rather than as
a claim about merge strategy, and said so in each row's provenance. A reader who
takes the role name literally would leave that optional role unfilled and we
would disagree on four rows.

**(c) The same release, differently complete in the two documents.** For
attention 0.4.1, DEVELOPMENT.md writes "release PR [#548], tag
`plugin-attention-v0.4.1`, sync `553ac79`" (no commit for #548) while the
scorecard writes "release PR #548 `beb4917`, tag …, marketplace sync `553ac79`"
(an unlabelled commit in the release PR's slot). Two occurrences of one release,
two different filled-role sets — correctly, because a row is about bytes in a
document, not about the release.

**(d) 0.78.0 in the scorecard.** "(feature PR #540, contract #539, tag
plugin-runtime-v0.78.0 — … — sync `51db10f`)". A release is asserted and a sync
commit is named, but the only PRs present are labelled *feature* and *contract*.
The release PR for that tag is #541 — which DEVELOPMENT.md names and this file
never does. That is `incomplete`, not `bound`: I will not import an occurrence
from another file to fill a role.

**(e) Timestamps that are not `iso-date` occurrences.** "the four-plugin `/hooks`
attestation `settings-20260712T015100Z-312fbb` (attested 2026-07-12T01:51Z)" —
the text dates the run outright, but `2026-07-12` there is followed by `T`, and
the registry's iso-date rule requires a non-word right boundary (or an optional
trailing `Z`). So a date is claimed and no occurrence exists to fill the role:
`incomplete`. Same shape at scorecard @56747, "the persona-release re-attestation
of 2026-07-12T01:51Z". These two are the cleanest `incomplete` rows in the
corpus.

## 4. What I marked `ambiguous`, and what would resolve it

17 rows (1 release-triple, 16 proof-date-binding). Each row's `provenance` states
the question. They fall into four groups.

**(i) Anaphoric dating — "the same day", "that day", "same-day" — 13 rows**
(D@54203, D@54374, D@64843, D@64900, D@70562, S@40514, S@40577, S@48316, S@48375,
S@60968, S@71275, S@114107, S@114162). The text does date something, and a run
is named nearby, but the dating predicate attaches to an *event* (a clearing, a
drift closure, a relocation) rather than to the run, and the only candidate
`iso-date` occurrence belongs to a different run's record. I bound the
anaphora where the phrase's only function in its sentence is to date the run
("The install proof taken earlier the same day, R, read partial 91%" →
`bound`), and asked where it dates the event instead ("Cleared the same day:
fresh attestation R1 and post-attestation record R2 restore observed parity" →
`ambiguous`). *Resolution:* one owner ruling on whether an anaphoric day phrase
transfers to the artifacts that performed the dated event, or only to the event.
That single ruling settles all 13 the same way.

**(ii) Entry-date inheritance — 1 row** (D@102189). The DEVELOPMENT.md dogfood
log is a sequence of bolded-date journal entries. Does an entry date bind a run
named inside the entry? I did not assume it does, because the very next entry in
that log (@104982) is headed **2026-05-10** and names `audit-20260509T…` inside
it — the entry date and the run's own day differ, and binding by inheritance
there would be a mispairing. I bound the one case where the dated entry's
subject *is* the run (@102513, "**2026-05-29** …: consensus run
`consensus-20260529T…` produced …") and asked about the one where the run is a
supporting citation. *Resolution:* an owner ruling on entry-date inheritance in
that log.

**(iii) "landed the same day as R" — 2 rows** (D@92795, S@60968). Grammatically
`R` is the comparison term, not the thing being dated; but each sentence also
carries a real `iso-date` occurrence. *Resolution:* a reading of whether "as" is
comparative or appositive here.

**(iv) A tag inside another PR's parenthetical — 1 row** (S@87713). "alongside
PR #529 (ADR-0042 `Accepted`, `plugin-designer-v0.2.0`), release PR #521,
release tag plugin-runtime-v0.77.0, marketplace sync commit `7dce7fe`". The
designer tag sits inside #529's parenthetical while #521 is given a *different*
explicitly-labelled "release tag". DEVELOPMENT.md's parallel sentence says "via
release PR [#521]" and I bound that occurrence; here the connective is gone.
*Resolution:* whether the scorecard sentence intends #521 to have cut both tags.

## 5. Anchors I think are in the domain but doubt should be measured

Two honest reservations, neither acted on — the registry declares the whole
family and §4.3 requires a row for every member, so all 437 are present.

- **`proof-run-id` occurrences that are pure artifact citations.** 129 of the
  292 anchors — 44% — are `not-a-claim`: settings executor artifacts, peer-run
  handles, bootstrap lifecycle ids, compat interval endpoints. These are
  occurrences of the family, but no reasonable reading of the surrounding prose
  has them asserting a date, and they will dominate any recall ratio computed
  over this relation. That is a property of the corpus rather than a defect in
  the registry — and §4.3 says plainly that the cost of a meaningful recall
  figure is a larger artifact — but a reader of the ratio should know that
  nearly half the denominator is prose that was never going to bind.
- **Tags inside capability inventories.** Eight anchors (ARCHITECTURE @17031,
  @17073; DEVELOPMENT @7208, @7250, @117858, @118561, @120281, @120323) sit in
  feature roll-ups that name no PR or commit anywhere in the
  surrounding kilobytes. `docs/ARCHITECTURE.md` contains **zero** pr-citation and
  **zero** commit-citation occurrences in the whole file, so no `release-triple`
  row anchored there can ever be `bound`. Measuring them is defensible — a lane
  that binds them is wrong and should be caught — but their outcome is fixed by
  the file's contents rather than by the annotation.

## 6. Deliberate emissions worth flagging to a reviewer

- **`artifact_only_scope: "out-of-scope"`** (§2.3). This is a bundle-delivered
  clean-room run; §11.1 delivers corpus blobs and shared inputs and nothing else.
- **`proof-run-id.artifact_present` is omitted, not stated.** The registry
  permits only `present` or `not-applicable` for it. `present` is a claim I
  cannot make — no run artifacts were delivered — and §2.3 says in terms that
  `not-applicable` is false, "because the field does apply". §2.3's resolution is
  the scope declaration rather than a repair of the field, and §8.3's third
  consequence reads omission as absence only for an `in-scope` run. So I declared
  the scope and left the field off. If a reviewer wants a state emitted anyway,
  that is a contract question, not an annotation one.
- **`canonical` is `unresolved` on every package-tag and commit-citation.**
  §5 makes resolving a literal to a canonical form the comparator's work against
  the frozen authority snapshot, and §9 puts both snapshots out of reach of every
  authoring lane; §9 also says an authority-derived value that cannot name its
  snapshot entry is `unresolved`.
- **No `quoted_context`.** §3.6 makes a quote that resolves to more than one span
  `unresolved`. Values repeat heavily in these documents, so a short window is often not
  unique (`doctor-…-7f2850` occurs 9 times across the three files,
  `settings-…-364c8f` 12). Rather than ship rebaseline aids that would not resolve, I shipped
  none. Byte spans plus `line`/`column` diagnostics carry the anchoring.
- **`parameters: {}`** on both policy declarations. This is a literal claim, not
  an omission: the annotation has no tunables. `ranking` records that no
  candidate scoring, distance measure or ordering was applied;
  `tie_policy: "ambiguous"` is what the 17 rows above exercise.
- **`prohibited_inputs_accessed` is not empty.** It records `TASK.md`, the task
  brief at the workspace root. It is outside `bundle/` and so is named, but it is
  not on §11.2's May-not list and carries no reading of this corpus. I read
  nothing else outside `bundle/` — no other lane's output, no comparator output,
  no authority snapshot, no `association-policy.md`, no construction inventory,
  and nothing from the network.

## 7. What I checked before calling this done

`work/verify.mjs` re-derives everything it checks and passes. `work/negctl.mjs`
mutates the artifact ten ways and confirms each check fires.

1. **Schema.** Validates against the sealed `artifact-schema.json` — a draft
   2020-12 subset validator covering `$ref`, `type`, `const`, `enum`, `pattern`,
   `minLength`, `minimum`, `required`, `items`, `properties` and
   `additionalProperties: false`. `role: "oracle"`, `contract_version: 2.2.0`.
2. **Coverage.** The anchor domain is re-enumerated by a *second, differently
   written* implementation of the registry's two recognition rules, directly from
   the pinned blobs. It yields 145 and 292; the artifact carries 145 and 292 rows,
   one per anchor, no duplicates, no row outside the domain, none missing.
3. **Spans.** Each of the 820 occurrences: blob id recomputed as a git object
   name and matched to the manifest; the range is a valid half-open range inside
   that blob; `blob[start:end]` decoded as UTF-8 equals the reported `literal`
   and re-encodes byte-identically (§3.5, §8.2). All three stage files are
   byte-length- and blob-verified against the manifest.
4. **Digests.** Bundle digest recomputed under §11.3's `path NUL len NUL bytes`
   framing over the four members in fixed order and matched to the recorded seal
   (`c7e68f04…`); manifest digest recomputed under §2.1's serialisation and
   matched to the manifest's own `digest` field (`b2f1433a…`); both policy
   digests recomputed under §4.5; the artifact digest recomputed under §11.4 over
   §2.1's serialisation with `attestation` removed (`90739b9f…`). The attestation's
   contract version, bundle digest and manifest digest agree with the artifact
   beside them (§8.2).
5. **Row consistency (§4.3, §7.3, §8.2).** Every `bound` row fills every required
   non-anchor role; every `incomplete` leaves at least one unfilled; every
   `not-a-claim` fills none; the anchor role never appears in `roles`; every role
   name is declared by its relation and every named identity is carried in
   `occurrences` under the family the registry declares for that role; every
   `provenance` opens with exactly one judgment tag.
6. **Policy shape (§4.5).** `parameters` is a flat object of scalars,
   `tie_policy` ∈ {`ambiguous`,`ranked`}, `class` and `ranking` non-empty,
   `anchor_domain` carries family/profile/restriction and equals the registry's
   declared domain for that relation.

Negative controls, all detected: bad `role`; an extra top-level property; a span
off by one byte; a dropped row; a duplicated row; a tampered artifact digest; a
tampered policy digest; a `not-a-claim` row carrying a role; the anchor role
placed inside `roles`; a provenance with no judgment tag.
