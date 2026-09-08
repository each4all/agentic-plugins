# Oracle annotation — one of two independent annotators

You are annotating a frozen corpus by hand. Everything you may read is in
`bundle/`. Do not look outside this workspace and do not search online for this
project.

Another annotator is doing the same work separately. You will not see their
output and they will not see yours; the two are compared afterwards, and
**disagreement between you is informative rather than a failure**. Do not try to
guess what a second reader would say.

## Your inputs

```
bundle/docs/assurance/evidence/measurement/measurement-contract.md   the contract — read it first
bundle/docs/assurance/evidence/measurement/family-registry.json      the relations and their anchor domains
bundle/docs/assurance/evidence/measurement/corpus-manifest.json      which files are the corpus
bundle/docs/assurance/evidence/measurement/artifact-schema.json      the shape you emit
bundle/<path>                                                         each corpus file, at its manifest path
```

The manifest's `path` values are the paths you emit.

## Your output

```
out/oracle.json    the annotation, role: "oracle", validating against artifact-schema.json
out/NOTES.md       how you worked, what you found hard, what you could not decide
```

## The one rule that matters most

**Do not write a program that decides the bindings.**

Contract §4.4 requires this artifact to be authored *by independent annotation
with adjudication, not by running a rule*, and says why: a rule here would be a
third implementation of a guess the contract already rejected, and it would rank
other work by similarity to itself rather than by correctness.

So: **read the text and judge what it says.** You may use tooling freely to
*find* candidates, to compute byte offsets, to check your spans round-trip, and
to assemble JSON — mechanical work is fine and expected. What you may not do is
let a pattern decide *whether a sentence makes a claim* or *which occurrence a
claim binds to*. That judgment is per-instance and belongs to you.

A useful test: if you could delete a row's `provenance` and regenerate the same
disposition from a regex, you have run a rule rather than annotated.

## What to annotate

For each relation in the registry, the anchor domain is declared there. **Work
out that domain yourself from the registry's recognition rules** — do not assume
a count, and if your enumeration surprises you, record that in NOTES.

Every anchor in the domain gets exactly one row (§4.3), with a disposition of:

- `bound` — this anchor makes the claim, and every required role is filled by a
  specific occurrence you can point at.
- `not-a-claim` — this anchor occurrence does not assert this relation here. A
  token can appear in prose without claiming anything.
- `ambiguous` — the text does carry a claim but you cannot tell which occurrence
  fills a role, or whether it is a claim at all.
- `incomplete` — a claim is made and a required role has no occurrence to fill.

**`ambiguous` is a real answer and is the honest one when you are unsure.** It
is also how you ask a question: put the question in `provenance` and a human
will adjudicate it. Do not force a decision to avoid it, and do not use it to
avoid reading either.

## Two fields that carry the weight

Each row's `provenance` (a string, per the schema) must record **both**:

1. **A judgment-type tag, exactly one**, as the first token:
   - `lexical:` — the text says it outright; a careful reader would not differ.
   - `interpretive:` — you had to read intent. Whether this sentence *claims* a
     relation or merely *mentions* one is the archetypal case.
   Be honest here rather than defensive. `interpretive:` is not an admission of
   weakness; a run with none at all would be the suspicious result.
2. **Why this row, in your own words**, naming what in the text decided it —
   enough that someone re-reading that passage can agree or disagree with you
   specifically.

## What "done" means

- `out/oracle.json` validates against the schema, `role: "oracle"`.
- Exactly one row per anchor in each declared domain.
- Every `bound` and `incomplete` row names exact occurrence spans for the roles
  it fills, and every span round-trips: decoding `bytes[start:end]` as UTF-8
  equals the `literal` you report (§3.2, §3.5).
- Digests per the contract: §11.3 for the bundle, §2.1's serialisation for the
  policy and artifact digests, §4.5 for the policy declaration.
- Your policy declaration's `class` should describe how you actually worked
  (annotation), and `parameters` should be honest — if you truly used no
  tunables, an empty object is the correct claim.

## Attestation

`prohibited_inputs_accessed` is an array and an empty one is a claim, not a
silence. §11.2 lists what you may not see. Name anything you read outside
`bundle/` there; an honest entry costs far less than a false empty one.

## In NOTES.md

- How you worked, including what you used tooling for and where you judged.
- The passages you found hardest, and why.
- Anything you marked `ambiguous`, and what you would need to resolve it.
- Any anchor you think the registry's domain includes but which you doubt should
  be measured, and why.
