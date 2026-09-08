# Adversarial self-review of your own oracle annotation

You previously annotated a frozen corpus and sealed an artifact. That artifact
is at `input/oracle.json` in your working directory. It is **your own** prior
output. You have never seen any other annotator's artifact and you will not see
one now.

This pass is not a proofread. Its purpose is to attack judgments that a second
reading might have accepted out of habit rather than evidence.

## Why this pass exists

Your prior rows each carry a judgment-type tag. The `lexical:` rows say the text
stated the thing outright. The `interpretive:` rows say you had to read intent.
An interpretive judgment that felt obvious is exactly the kind that a second
reader with the same habits would also accept — and agreement produced that way
is not evidence of correctness. This pass exists to put those rows under an
argument they have not yet had to survive.

## Scope

Review every row in your artifact whose provenance is tagged `interpretive:`.
Take them in this order:

1. every `interpretive:` row whose disposition is `not-a-claim`;
2. every `interpretive:` row whose disposition is `bound`;
3. every remaining `interpretive:` row.

Rows tagged `lexical:` are out of scope unless, while working, you find one whose
provenance does not actually support it — then fix that one too and say so.

## The method

For each in-scope row, in this order:

1. Re-read the anchor's surrounding prose in the corpus. Read it before you
   re-read your own provenance, so the text gets the first word.
2. Write the **strongest case you can** that your recorded disposition is wrong,
   and that some other disposition is right. Argue it as if you were being paid
   to defeat the row. A `not-a-claim` is attacked by showing the sentence does
   assert the relation. A `bound` is attacked by showing the sentence does not
   assert it, or that it does not choose the physical occurrence you named.
3. Then decide, on the bytes, whether that case defeats the original. Only the
   text decides. "My first reading was reasonable" is not a defence; "the
   sentence says X" is.
4. Record the outcome.

`ambiguous` remains a legitimate destination and is often the honest one here:
if your attack shows the prose does not choose between two readings, the row was
never `bound` or `not-a-claim` in the first place. Put the question in
`provenance` so a human can adjudicate.

## The rule that still matters most

Do not write a program that decides. Contract §4.4 requires adjudication rather
than a rule, and this pass is bound by it exactly as the first one was. Use
tooling to locate rows, compute offsets, verify spans, and assemble JSON. Do not
let a pattern decide whether a sentence makes a claim, or which occurrence a
claim binds to. If a row's new disposition could be regenerated from a regex,
you ran a rule instead of reading.

## Constraints on the result

- The domain does not change. Exactly one row per anchor, the same anchors,
  no additions and no removals.
- Contract §4.3 still holds: an anchor's own occurrence is never repeated inside
  its `roles`.
- Every named span must still round-trip against the corpus bytes.
- Re-seal the artifact. The revised `attestation.artifact_digest` must be
  recomputed over the revised content; it supersedes the earlier seal.
- Record anything you read outside `bundle/` in
  `attestation.prohibited_inputs_accessed`, including `TASK.md` and
  `input/oracle.json`.

## Produce

```
out/oracle.json    the revised artifact, role: "oracle", validating against the
                   sealed artifact schema in the bundle
out/REVIEW.md      the record of this pass
```

`out/REVIEW.md` must contain:

1. How many rows were in scope, and how many you changed, by transition
   (e.g. `not-a-claim -> bound: n`).
2. For **every changed row**: its anchor identity, the old and new disposition,
   the attack that succeeded, and the words in the corpus that decided it.
3. For the rows you attacked and that **survived**: how many, and the three or
   four hardest, with the attack you made and why the text defeated it.
4. Any `lexical:` row you corrected, and why.
5. What you would still want a human to decide.

Both a very low change count and a very high one are results that need
explaining, not targets to hit. Do not tune toward either. If your first pass
was mostly right, say so and show the attacks that failed.

## Verification

Before reporting done, verify with a check you write: the schema validates; the
domain is unchanged against `input/oracle.json`; exactly one row per anchor;
every span round-trips as UTF-8 against the corpus bytes; §4.3 holds; and every
digest matches the contract's definition. Report what you checked and what the
checks found.

Node 24 is available. No network, no dependencies.
