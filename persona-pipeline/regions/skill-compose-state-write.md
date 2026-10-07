When `/{{persona}}:compose` runs as a sub-step of another {{persona}} workflow
command, the invoking command writes the artifact + progress to its workflow
file.
{{^capability commit_surface}}
This skill itself does not write workflow state. When invoked
standalone, no workflow file write occurs.
{{/capability}}
{{#capability commit_surface}}
This skill itself writes no phase note or progress; its one workflow write is
the `code` profile's commit-manifest recording below, which keeps every file
it writes in the workflow's `commit_manifest` for the commit. When invoked
standalone, no workflow file write occurs.
{{/capability}}
