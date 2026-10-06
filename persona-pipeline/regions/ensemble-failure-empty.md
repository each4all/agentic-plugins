- **Detect**: Envelope `status: success` but `stdout` parses to no
  findings, or is structurally valid but missing required fields for some
  findings.
- **Action**: Parse only the findings that pass structural validation;
  discard the rest. Continue with the salvageable subset.
- **Surface**: Mention in the completion summary that ensemble coverage
  was partial.
