# Lane S1 — typed occurrence exporter

You are authoring **one lane** of a two-lane independent measurement. Everything
you may read is in `bundle/`. Do not look outside this workspace, and do not
search the internet for this project.

## Your inputs

```
bundle/docs/assurance/evidence/measurement/measurement-contract.md   the contract — read it first
bundle/docs/assurance/evidence/measurement/family-registry.json      what to recognise, and over which anchors
bundle/docs/assurance/evidence/measurement/corpus-manifest.json      which files are the corpus
bundle/docs/assurance/evidence/measurement/artifact-schema.json      the shape you emit
bundle/<path>                                                         each corpus file, at its manifest path
```

The manifest's `path` values are the paths you emit. A file the manifest calls
`docs/ARCHITECTURE.md` lives at `bundle/docs/ARCHITECTURE.md` and you emit
`docs/ARCHITECTURE.md`.

## Your output

```
out/exporter.mjs        your exporter, runnable as `node out/exporter.mjs`
out/artifact.json       what it emits
out/tests.mjs           your tests, runnable as `node --test out/tests.mjs`
out/NOTES.md            what you implemented and why; anything you could not decide
```

`out/artifact.json` must validate against `artifact-schema.json` and must set
`role: "lane"`.

## What the contract requires of you

Read it rather than trusting this summary; these are the clauses that bind you
most directly.

- **§4.2 — you choose the extraction policy.** The contract fixes no rule for
  binding one occurrence to another. Implement whatever mechanism you judge
  best. This is a real choice, not a formality.
- **§4.5 — declare what you implemented.** One policy declaration per relation,
  structured and digested, never a bare name. `parameters` is a flat object of
  scalars and must name every tunable your implementation has: an empty object
  is a claim that there are none. `class` is free text.
- **§4.3 — every in-scope anchor gets exactly one row.** For each relation, the
  anchor domain is declared in the registry. Emit exactly one row per anchor
  occurrence in that domain, with a disposition of `bound`, `not-a-claim`,
  `ambiguous`, or `incomplete`. **A missing row is a structural failure, not a
  silent pass.** If you cannot decide, `ambiguous` is a result and is the honest
  answer; inventing a binding is not.
- **§4.3 again — the disposition must match the roles you name.** `bound` fills
  every required role; `incomplete` leaves at least one required role unfilled;
  `not-a-claim` fills none. An unfilled role is **absent**, never null.
- **§3.2 — identity is (path, blob, start_byte, end_byte).** Half-open byte
  ranges over the exact file bytes. Value is never identity: two identical
  lexemes at different spans are two occurrences.
- **§3.5 — spans must survive a round trip.** Decoding `bytes[start:end]` as
  UTF-8 must yield exactly the `literal` you report. If you normalise text
  internally, keep a complete map back to byte offsets; a normalised index is
  not a source position.
- **§3.4 — recognition rules come from the registry**, stated as lexical
  observables. Implement them as written. Where a family declares `fields` with
  a `vocabulary`, its `precedence` decides which member applies.
- **§5 — do not resolve canonical values.** Report the literal. Resolving a
  literal against git or any live state is the comparator's work, not yours,
  and you have no access to it here.

## Digests you must compute

All four are specified in the contract; none is derivable without reading it.

- `manifest_digest` and `corpus_commit` — read them from the corpus manifest.
- `bundle_digest` — §11.3. Over the bytes of the four shared inputs in the fixed
  order the clause gives, with the NUL-delimited framing it specifies.
- each policy's `digest` — §4.5, over §2.1's canonical serialisation of the
  declaration without its own `digest`.
- `attestation.artifact_digest` — §11.4, over §2.1's serialisation of the
  artifact with its `attestation` key removed.

§2.1 fixes the serialisation exactly: lexicographic key order at every level,
two-space indentation, trailing newline. Read that clause; the ordering rule has
a subtlety about integer-like keys that a naive implementation gets wrong.

## Your tests

`out/tests.mjs` is yours and is not the acceptance test — an independent lane
checks your output later. Test the things that are easy to get wrong and hard to
see: byte-span round trips where text wraps or is indented, values that repeat
within one file, non-ASCII bytes, spans at a file's first and last byte, tokens
that sit hard against a delimiter or a code fence, and anchors your policy leaves ambiguous.

For every test, ask whether it would still pass if the behaviour it names were
deleted. If it would, it is not testing that behaviour.

## Attestation

`attestation.prohibited_inputs_accessed` is an array, and an empty array is a
claim rather than a silence. §11.2 lists what a lane may not see. If you read
anything outside `bundle/` that bears on this measurement, name it there. An
honest entry costs the measurement far less than a false empty one.

## What "done" means

`node out/exporter.mjs` writes `out/artifact.json`; the artifact validates
against the schema; every in-scope anchor has exactly one row; every span round
trips; `node --test out/tests.mjs` passes. Report in `out/NOTES.md` what you
implemented, what you decided, and what you could not decide.
