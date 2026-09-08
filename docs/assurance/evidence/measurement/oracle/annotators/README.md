# Lane and annotator briefs — reuse these bytes, do not rewrite them

These are the exact inputs the measurement lanes were given. They are kept
verbatim because rewriting one silently destroys the property the whole
apparatus is built on.

| File | Given to |
|---|---|
| `annotator-TASK.md` | annotators A and B — **the same bytes to both** |
| `s2a-prompt.xml` | annotators A and B — the peer-runner prompt wrapping the brief above |
| `adversarial-TASK.md` | both annotators' adversarial self-review |
| `adversarial-prompt.xml` | the wrapper for that pass |
| `lane-s1-TASK.md` | lane S1 (the typed occurrence exporter) |
| `s1-prompt.xml` | the wrapper for lane S1 |

## Why "do not rewrite" is a correctness rule, not tidiness

**Byte-identical briefs are what make two annotations independent.** §4.4
requires the oracle to be authored by independent annotation with
adjudication, and §11.1 puts isolation in the delivery rather than in
instructions. If A and B receive briefs that differ at all, a disagreement
between them can no longer be attributed to the corpus — it may be an artifact
of the wording, and nothing in the comparison can tell the two apart.

**Editing a brief after seeing a result steers the re-run toward that result.**
This is the same failure §11.5 names for repairs during comparison: it converts
an independent measurement into a fitting exercise. A brief improved in light
of what the first pass produced is no longer measuring the corpus.

**A rewritten brief invalidates comparison against earlier runs.** The recorded
disagreement rates, judgment-type ratios and adjudications in
`../adjudication.md` are all conditional on these exact instructions.

## If a brief genuinely needs to change

Treat it the way §10.3 treats the corpus: a deliberate, recorded rebaseline,
not an edit. Version the brief, re-run every lane that reads it, and re-derive
anything that cited the old results. Do not mix a brief change with a re-run
that is supposed to answer some other question.

## Reproducing a dispatch

```
node scripts/evidence-measurement.mjs seal --verify        # expect c7e68f04…
node scripts/evidence-bundle.mjs build --out <ws>/bundle
mkdir <ws>/out && cp <the TASK.md for this lane> <ws>/TASK.md
# adversarial passes also need the lane's own prior artifact at <ws>/input/oracle.json
peer-runner run --peer codex|claude --prompt-file <the .xml> --cwd <ws> …
```

The working directory is a scratch workspace, never the repository: the lane
must see the bundle and nothing else (§11.1), and a peer pointed at the repo
can also revert uncommitted work in it.
