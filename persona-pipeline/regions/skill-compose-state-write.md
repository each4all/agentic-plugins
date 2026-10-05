When `/{{persona}}:compose` runs as a sub-step of a {{persona}} workflow command,
the invoking command writes the artifact + progress to its workflow file.
This skill itself does not write workflow state. When invoked standalone,
no workflow file write occurs.
