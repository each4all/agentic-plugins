Output-file conventions for the {{brief_profile}} profile of
`{{persona}}:investigate`. This is the only {{persona}}:investigate profile that
produces a separate user-facing artifact; any future non-brief profiles
write phase notes through `state.mjs` to the workflow `.md` and do not
produce a standalone file.

{{persona}} ships its own copy of these conventions (ADR-0010 §5 no
cross-plugin import; ADR-0029 §Neutral copy/adapt). The filename and
env-var name are {{persona}}-owned (`{{brief_file}}` / `{{output_root_env}}`)
— {{persona}} has no Stage-1 backward-compatibility constraint.
