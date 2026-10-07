Output-file conventions for the {{brief_profile}} profile of
`{{persona}}:investigate`. This is the only {{persona}}:investigate profile that
produces a separate user-facing artifact; every other profile, present or
future, writes phase notes through `state.mjs` to the workflow `.md` and
produces no standalone file.

{{persona}} ships its own copy of these conventions (ADR-0010 §5 no
cross-plugin import; ADR-0029 §Neutral copy/adapt). The brief file is
`{{brief_file}}`, and `{{output_root_env}}` overrides where it is saved.
