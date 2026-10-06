When `{{persona}}:investigate --profile={{brief_profile}}` runs in command-mode,
the bidirectional {{ensemble_type}} ensemble (per
`{{brief_profile}}-ensemble.md`) may contribute claims and sources. The
brief artifact does NOT carry any source-of-discovery labels:

- No host-named markers anywhere in the brief — none of `[Local]`,
  `[Peer]`, `[Both]`, or any host-specific equivalent.
- Numeric `[N]` citations remain the only labeling format in Findings
  and Sources.
- The peer's internal citation labels are NEVER copied verbatim into the
  brief — they are remapped to capture-order numbering by Citation
  Remapping (canonical rule in `{{brief_profile}}-ensemble.md`).

The presence or absence of ensemble execution must NOT be inferable from
reading the brief. Ensemble status (unavailable, partial, degraded) is
communicated only in the user-facing completion summary that follows the
save, never inside the brief artifact.
