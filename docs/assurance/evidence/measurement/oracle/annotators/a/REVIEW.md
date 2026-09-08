# Adversarial self-review

## Result

The prior artifact contained 177 in-scope rows tagged `interpretive:`. I attacked all 177 in the required order: 121 `not-a-claim`, then 45 `bound`, then the remaining 11. Nineteen in-scope rows changed and 158 survived unchanged. While comparing a repeated temporal construction, I also found and corrected one out-of-scope `lexical:` row. The revised artifact therefore changes 20 anchor rows in total while retaining the same 437-row domain.

In-scope transitions:

| Transition | Rows |
|---|---:|
| `not-a-claim -> bound` | 1 |
| `bound -> not-a-claim` | 5 |
| `bound -> ambiguous` | 1 |
| `bound -> bound` (optional role removed) | 4 |
| `ambiguous -> not-a-claim` | 4 |
| `ambiguous -> incomplete` | 3 |
| `incomplete -> incomplete` (optional role removed) | 1 |
| **Total in scope** | **19** |

The additional lexical correction is `incomplete -> not-a-claim` (one row). Final disposition counts are 281 `bound`, 130 `not-a-claim`, 4 `ambiguous`, and 22 `incomplete`.

I made the judgments by rereading the corpus around each anchor before rereading the old provenance and arguing for a contrary disposition. Programs were used only to locate already-selected rows, expose byte windows, assemble the manually adjudicated changes, compute digests, and verify invariants. No program decided whether prose made a claim or selected a role occurrence, as required by contract §4.4.

## Identity shorthand

Contract §3.2 defines physical identity as `(path, blob, start_byte, end_byte)`. All rows below have profile `stage-docs`. To keep the ledger readable:

- **S** = `docs/assurance/omcc-cutover-scorecard.md`, blob `99b33d0e8c1dcd2693b95afa322422e2efa232f6`
- **D** = `docs/DEVELOPMENT.md`, blob `f5e07a22bcc38533b929161c5243ea61a2aba911`

Each entry gives the relation, file shorthand, half-open byte span, and literal, which together identify the anchor row.

## Changed rows

1. **Index 67 — `proof-date-binding`, S `[54752,54782)`, `doctor-20260713T030956Z-20dcc3`: `bound -> not-a-claim`.** The successful attack confined the date to the confirmation and attestation, not the later observation record. The deciding words are “`The operator completed that confirmation the same day: the fresh ... attestation ... restored observed parity in the post-attestation record doctor-...`”. The anchor has no temporal modifier of its own, so §4.3 does not permit the old binding to S `[53004,53015)` `2026-07-13Z`.

2. **Index 122 — `proof-date-binding`, S `[84461,84493)`, `settings-20260713T030937Z-f50815`: `ambiguous -> not-a-claim`.** The successful attack showed that the only plausible date, S `[84070,84081)` `2026-07-13Z`, applies to “`The same-day post-attestation record doctor-...`”; this settings anchor is merely the nested “`fresh attestation settings-... at the upgraded versions`”. It could predate the doctor. There are not multiple unranked date occurrences, and no date claim is asserted for this anchor, so §4.3 rules out `ambiguous`.

3. **Index 125 — `proof-date-binding`, S `[86612,86644)`, `settings-20260710T153728Z-5796b6`: `ambiguous -> not-a-claim`.** The successful attack was that “`the 0.78.1-native proof doctor-... (recorded 2026-07-10Z ...; /hooks re-attestation settings-...)`” directly dates the doctor, while the attestation is supporting evidence inside its parenthesis. Parenthetical membership does not assert the attestation date. The later “`2026-07-11 relocation`” concerns another event. Under §4.3 this is no claim, not multiple candidates.

4. **Index 144 — `proof-date-binding`, S `[107588,107618)`, `doctor-20260803T033236Z-f56d25`: `ambiguous -> not-a-claim`.** The attack succeeded because “`the 0.88.1 proof recorded on 2026-08-03Z (doctor-... post-attestation, after install proof doctor-...)`” dates the post-attestation doctor. The words “`after install proof`” establish order only; unlike another occurrence elsewhere in the corpus, this occurrence is not called a same-day install proof. The sole plausible date does not apply, so §4.3 requires `not-a-claim`.

5. **Index 146 — `proof-date-binding`, S `[108263,108293)`, `doctor-20260803T091403Z-7f2850`: `bound -> not-a-claim`.** The successful attack was syntactic scope: in “`the same-day fresh attestation settings-... and post-attestation record doctor-... restore`”, `same-day` is internal to the first noun phrase. There is no predicate-level same-day modifier for the coordinated doctor record. That defeats the old S `[107506,107517)` date role under §4.3.

6. **Index 154 — `proof-date-binding`, S `[114107,114137)`, `compat-20260722T011840Z-a3fb14`: `bound -> not-a-claim`.** The successful attack distinguished the earlier operation from the dated closing operation. The corpus says drift “`was closed the same day by the compat cycle — ... ingest in compat-... , drift=none re-check in compat-...`”. Closure dates the drift-none re-check; the ingest may precede the closure day. The old S `[112894,112905)` binding therefore overreached under §4.3.

7. **Index 175 — `proof-date-binding`, S `[122879,122909)`, `doctor-20260713T030956Z-20dcc3`: `bound -> not-a-claim`.** As at index 146, the words are “`the same-day fresh attestation settings-... and post-attestation record doctor-... restored`”. The temporal modifier belongs to the attestation noun phrase, not the doctor noun phrase or the predicate. That defeats the old S `[122123,122134)` binding under §4.3.

8. **Index 181 — `proof-date-binding`, S `[124379,124409)`, `doctor-20260710T044745Z-1a789e`: `ambiguous -> incomplete`.** The successful attack rejected both the old uncertainty-about-claim reading and the nearby-date candidate. “`the 0.77.2 record doctor-... ...; the same-day baseline-refresh slice closed it`” asserts that this record shares the closure day, but S `[123668,123679)` `2026-07-10Z` explicitly dates a different 0.78.1 record. Thus the claim exists but has no surviving ISO-date occurrence; §4.3 makes it `incomplete`, not `ambiguous`.

9. **Index 192 — `proof-date-binding`, S `[128415,128445)`, `doctor-20260713T030956Z-20dcc3`: `bound -> not-a-claim`.** The attack succeeded because the sentence has separate coordinated clauses: “`The operator's same-day /hooks confirmation produced ... settings-...`”, then “`and the post-attestation record doctor-... restores ...`”. The same-day modifier is confined to the first clause, so the old S `[127734,127745)` role is not asserted for this anchor (§4.3).

10. **Index 200 — `proof-date-binding`, S `[130380,130410)`, `doctor-20260722T012908Z-472538`: `not-a-claim -> bound`.** The successful attack found explicit local coreference within one sentence. Its subject is “`The ADR-0047 Release B install (2026-07-22Z, doctor-20260722T012908Z-472538, ...)`”, and the later physical occurrence calls itself “`the install proof doctor-20260722T012908Z-472538`”. Those words carry the stated install date to this repeated occurrence. The new date role is S `[129789,129800)` `2026-07-22Z`; §4.3 therefore requires `bound`.

11. **Index 282 — `proof-date-binding`, D `[94260,94290)`, `doctor-20260710T044745Z-1a789e`: `ambiguous -> incomplete`.** The attack against the old candidates succeeded. “`the 0.77.2 record doctor-... whose ... caveat was closed the same day`” makes a date claim, but “`patch drift after the 2026-07-10 baseline`” dates a baseline and “`the 0.78.1-native 2026-07-10Z record doctor-20260710T153802Z-276226`” dates another doctor. Neither is a role candidate for this physical anchor. With none rather than several, §4.3 requires `incomplete`.

12. **Index 283 — `proof-date-binding`, D `[94426,94456)`, `compat-20260710T054356Z-34315e`: `ambiguous -> not-a-claim`.** The same temporal-scope attack as index 154 succeeded. The caveat “`was closed the same day by the baseline-refresh slice (compat-... ingest, post-refresh drift: none compat-...)`”. The anchor is the earlier ingest, not the identified post-refresh closing step, and may predate the closure day. Under §4.3 it makes no proof-date claim; the two old provenance dates never become candidates.

13. **Index 284 — `proof-date-binding`, D `[94494,94524)`, `compat-20260710T104459Z-67ece6`: `ambiguous -> incomplete`.** Here the attack reached a different result because the deciding words identify this anchor as “`post-refresh drift: none`” inside the slice that “`closed the same day`”. A date claim exists, but the baseline date and the 0.78.1 doctor date describe other subjects. With no ISO-date occurrence for this claim, §4.3 requires `incomplete`.

14. **Index 352 — `release-triple`, S `[87227,87249)`, `plugin-runtime-v0.78.0`: `incomplete -> incomplete`, optional role removed.** The attack did not defeat the disposition: “`The prior 0.78.0 loop shipped`” asserts a release, while the list says “`feature PR #540, contract #539, tag plugin-runtime-v0.78.0 ... sync 51db10f`”; neither labeled PR is the required release PR. The role attack did succeed: the exact words are only “`sync 51db10f`”, not marketplace sync. The old `marketplace_sync` S `[87347,87354)` was removed; the required role remains unfilled under §4.3.

15. **Index 353 — `release-triple`, S `[87713,87735)`, `plugin-designer-v0.2.0`: `bound -> ambiguous`.** The successful attack exposed competing physical PR scope. The corpus says “`PR #529 (ADR-0042 Accepted, plugin-designer-v0.2.0), release PR #521, release tag plugin-runtime-v0.77.0`”. S `[87685,87689)` `#529` is local to the designer tag, while S `[87750,87754)` `#521` is explicitly a release PR but sits with the runtime tag. The prose supplies no “via” or other words ranking those PR occurrences for the designer anchor. Because equal values or adjacent facts cannot erase physical identity (§3.2), §4.3 requires `ambiguous`; the old PR and sync roles were removed.

16. **Index 426 — `release-triple`, D `[89728,89751)`, `plugin-attention-v0.4.1`: `bound -> bound`, optional role removed.** The required role survives on “`release PR #548, tag plugin-attention-v0.4.1`”. The successful role attack is that the next words are only “`sync 553ac79`”, while this corpus elsewhere expressly distinguishes `marketplace sync` and `stage-doc sync`. The old `marketplace_sync` D `[89760,89767)` was not earned. Section 4.3 still permits `bound` because D `[89662,89666)` `#548` fills the required role.

17. **Index 428 — `release-triple`, D `[94077,94099)`, `plugin-runtime-v0.78.0`: `bound -> bound`, optional role removed.** “`contract PR #539 + release PR #541, tag plugin-runtime-v0.78.0`” defeats competing-PR attacks and retains D `[94011,94015)` `#541`. But the exact trailing words are only “`sync 51db10f`”, not marketplace sync, so the optional D `[94108,94115)` role was removed. Required-role completeness still makes the row `bound` under §4.3.

18. **Index 429 — `release-triple`, D `[94703,94725)`, `plugin-runtime-v0.77.2`: `bound -> bound`, optional role removed.** “`fix PR #534 + release PR #535, tag plugin-runtime-v0.77.2`” explicitly selects D `[94637,94641)` `#535` over the fix PR. The role attack succeeds only against the bare “`sync e351888`”, which does not say marketplace; D `[94734,94741)` was removed. The required role remains filled (§4.3).

19. **Index 431 — `release-triple`, D `[96213,96235)`, `plugin-designer-v0.2.0`: `bound -> bound`, optional role removed.** The words “`plugin-designer-v0.2.0) via release PR #521`” expressly defeat the competing local `#529` attack and retain D `[96254,96258)` `#521`. The successful role attack is against the separate bare “`sync commit 7dce7fe`”; it does not identify marketplace sync, so D `[96328,96335)` was removed. The row remains `bound` under §4.3.

20. **Index 269 — `proof-date-binding`, D `[87752,87782)`, `doctor-20260713T030956Z-20dcc3`: `incomplete -> not-a-claim` (lexical correction).** This was outside the planned scope but repeated index 67’s construction. The old provenance called it lexical and said the doctor was included in “`The operator completed that /hooks confirmation the same day`”. The corpus actually continues “`: the fresh ... attestation settings-... restored observed parity in the post-attestation record doctor-...`”. The same-day modifier dates the confirmation and attestation, not necessarily the later doctor. The lexical claim was unsupported, so I retagged the provenance `interpretive:` and changed the row to `not-a-claim` under §4.3.

## Attacks that survived

Of the 177 in-scope rows, 158 survived their attacks unchanged. The hardest were:

- **Index 80 — S `[60968,60998)` `doctor-20260711T045954Z-731e34`, `bound`.** Attack: an explicitly referenced narrative above contains a different physical occurrence of the same run and another July 11 date, so the old role might be mispaired. The text defeats it locally: “`(2026-07-11; install proof landed the same day as doctor-...)`” makes S `[60918,60928)` the immediate antecedent; “`see ... above`” requests detail and does not displace that span.

- **Index 33 — S `[38938,38970)` `settings-20260808T065145Z-c8409f`, `ambiguous`.** Attack: bind the closer following date, or call only the doctors dated records and make the settings row `not-a-claim`. The text defeats both: “`Two same-day records`” gives dated doctor endpoints on either side, and “`after ... settings-... recorded a fresh attestation ..., doctor-...`” temporally brackets the settings event on that day. S `[38713,38724)` and S `[39139,39150)` are distinct, equally usable physical occurrences, so §3.2 and §4.3 preserve `ambiguous`.

- **Index 158 — S `[115410,115440)` `doctor-20260722T021258Z-4c7514`, `bound`.** Attack: a post-attestation doctor might have been recorded later than the same-day confirmation. The sentence defeats it at result scope: “`restores ready — which landed the same day:`” is followed by “`the post-attestation record doctor-... restored observed parity`”. Unlike the failed noun-phrase cases, the same-day relative clause dates the restoration in this doctor record.

- **Index 280 — D `[92795,92825)` `doctor-20260711T045954Z-731e34`, `bound`.** Attack: “`see the newest record above`” exposes a different occurrence paired with D `[89374,89385)` `2026-07-11Z`, producing a second candidate. The local parenthesis defeats it: “`resolved 2026-07-11 by restructure: ... the install proof landed the same day as doctor-...`”. D `[92603,92613)` is the immediate date; the cross-reference supplies supporting narrative rather than an alternative physical role.

## Remaining human decisions

I would still want a human to decide four narrow questions:

1. Whether index 353’s scorecard grammar shares `release PR #521` with the designer tag, or confines it to `plugin-runtime-v0.77.0`. I left the row `ambiguous` because the bytes do not rank `#529` and `#521` for the designer occurrence.
2. Whether the two `2026-07-20` occurrences at S `[116918,116929)` and S `[117566,117576)` can be ranked for the still-ambiguous settings/doctor anchors at indices 165 and 166, rather than merely agreeing in value.
3. Whether the DEVELOPMENT release-history convention makes bare `sync` unambiguously mean marketplace sync. I removed five optional roles because the local words omit `marketplace` while the corpus distinguishes multiple sync kinds.
4. Whether the “same-day” clauses at indices 181, 282, and 284 should count as incomplete proof-date claims when no ISO-date occurrence belongs to the anchor. I treated relational same-day wording as a claim with a missing required role, following §4.3.

## Verification

I wrote and ran a dependency-free Node check over the revised artifact and the sealed bundle. The final full run found:

- **Schema:** pass against the sealed `artifact-schema.json`.
- **Domain:** pass — 437 rows, 437 unique relation/anchor identities, exactly the same anchor set as `input/oracle.json`, and one row for every registry-declared anchor-domain occurrence.
- **Occurrence inventory:** pass — all 821 occurrences are unchanged. Every occurrence literal, anchor, and named role resolves to the exact frozen blob and round-trips from its half-open byte span through fatal UTF-8 decoding.
- **Contract §4.3:** pass for every mechanically checkable condition — every role is declared and resolves to the required family, every `bound` row fills its required non-anchor role, every `incomplete` row leaves one unfilled, every `not-a-claim` row has no roles, and no anchor occurrence is repeated in its own `roles`.
- **Frozen files:** pass — all 77 corpus files and four shared inputs match their declared byte lengths and Git-blob SHA-1 identities.
- **Digests:** pass under the contract’s recursive lexicographic canonical JSON and bundle framing definitions. Manifest: `b2f1433af69131779bc1b2cc9e69f6a54709714e89145f9498a1c3959e6a7ebc`; bundle: `c7e68f04e450fa1e6fa7497fce3ca36e077e2f38fecc34605ee5d79e242c219f`; release policy: `ae1c836d511d4192a205cd39be9a91f2428de8e2828e7c24685c0189c969ab77`; proof-date policy: `ed102a0de1ed3958a9225f85ef275e7ee9adb4abf52bea28f5066b899ec32d22`; revised artifact: `56466de259efd542a4c404b75babbdbe4761e65a651389b830680bb11aa49aae`.

The first checker invocation stopped at manifest digest recomputation because the check removed a nonexistent `manifest_digest` property instead of the manifest’s actual `digest` property. I corrected the check and reran the entire suite from the beginning; the results above are from that clean passing run.

## Inputs outside `bundle/`

This pass read:

- `TASK.md`, the required assignment brief.
- `input/oracle.json`, my own prior sealed artifact.

The revised attestation also preserves the original artifact’s disclosure of `/Users/lmuffin/.codex/memories/MEMORY.md`; that file was accessed by a structural helper during the original annotation, not during this review, and the retained disclosure says no relevant project content was returned. No network or other external corpus input was used.
