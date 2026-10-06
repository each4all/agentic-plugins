**Code-backed floor vs prose-only fields (honest limits).** Of the six
fields, only the compact core survives into durable state (the
`next_action` string) and is therefore **code-emitted** at terminal
completions — the runtime footer renders it as `recommended next work`,
alongside the pointer-shaped evidence it also code-emits (the workflow
path artifact and the `workflow checkpoint` line). `rejected_alternatives`,
the full `rationale` and `confidence` have **no durable home** (ADR-0029 §3
freezes the `next_action` schema) and thus **zero active triggers** (the
ADR-0031 lesson): they render only because the completing surface follows
this contract, and are pinned by shape tests, not by execution. The
canonical six-field template, the completion-flag minimum-content
criteria, and the footer's generic-fallback visibility rules live in the
runtime plugin's `docs/completion-output-contract.md`; every persona
completion surface carries the template as a structure-pinned block
(`tests/plugin-shape/test-completion-output-contract.mjs`).
