The peer's response uses peer-internal labels (none, prose, or its own
numbering scheme). These are NOT copied into the final brief. Mapping
rule:

1. For each peer source URL, canonicalize: strip tracking parameters and
   trailing-slash variations.
2. Compare against the local host's already-captured Sources by canonical
   URL.
3. If match: the source is already in the brief; the peer finding's
   citation is the existing `[N]`.
4. If no match (new source from the peer), apply Path A or Path B from
   "PEER-ONLY handling" above. Path A appends a new entry to Sources in
   research capture order — the next available `[N]`. Path B does not
   modify Sources.

The brief's Sources section remains single-numbered, capture-order
preserving, and URL-deduplicated per `{{brief_profile}}-spec.md`. The peer
contributes to that ordering only via Path A.
