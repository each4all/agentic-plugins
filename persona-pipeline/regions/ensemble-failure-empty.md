- **Detect**: Envelope `status: success` but `stdout` parses to no
  findings, or is structurally valid but missing required fields for some
  findings.
- **Action**: Parse only the findings that pass structural validation;
  discard the rest. Continue with the salvageable subset. A completed run
  with no usable answer at all settles as verdict `degraded`. `settle` sees
  an empty or unreadable answer itself; an answer that parses to no
  findings, only structural shell, reads to it like any other, so pass
  `degraded` as the synthesis verdict then.
- **Surface**: Mention in the completion summary that ensemble coverage
  was partial.
