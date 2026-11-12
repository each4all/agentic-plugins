---
name: refine
description: "Applies critique findings or feedback and regenerates the image — the image plugin's refinement verb. Use after a critique to iterate on a generated image. Each regeneration is a new spending loop with explicit cost disclosure. Trigger phrases include 'refine the image', 'regenerate with changes', 'apply the feedback', 'fix the image', 'iterate on this', '이미지 보완', '다시 생성', '피드백 반영', '수정해서 다시'."
---

# Refine (image capability)

The image plugin's refinement verb (ADR-0010 §2, ADR-0037 Decision 1). Applies
critique/feedback and regenerates through Codex's integrated gpt-image — it
**reuses `compose-dispatch`** (the same generation + return-validation path).

## When invoked

0. **Quality tier** — the refine keeps the quality the image was made at,
   never a fixed tier. Read it from two sources:

   - the brief's `output.quality` (`brief.json`, `docs/contracts.md` §3);
   - the previous run this refine iterates on — the compose run, or the last
     refine run, whose image the feedback is about — its manifest's
     `requested_parameters.quality` (`docs/contracts.md` §4). Identify that
     run by its run id or image path; a run you cannot identify is no source.

   When both name the same tier, or only one names a tier, use it. When they
   name different tiers, or neither names one, do not pick silently: say
   what each source holds, propose a tier with its reason (a conflict: the
   brief's, as the stated intent; none: `medium`, the tier the estimate
   prices by default), and ask the user to confirm or choose before step 1.
   **The tier is not inherited by the helper:** pass it as `--quality <tier>`
   on every call, the estimate's and the generation's.

1. **Cost gate** (`docs/contracts.md` §7, §9): each refine is a **new
   generation** — disclose the per-iteration cost **before** regenerating, and
   with it, on the Claude host, that the base prompt and the feedback go to
   Codex (OpenAI), which runs in the repository and can read files there;
   ask no confirmation. The helper prints the same disclosure before it
   sends, and computes the cost without spending:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/refine-dispatch.mjs" --estimate-only --quality <tier>
   ```

   The disclosure names the tier the estimate priced (`cost.tier`) and where
   it came from (the brief, the previous run, or the user). When
   `cost.tier_assumed` is `true` no known tier reached the helper and it
   priced `medium`: say so rather than quote it as the run's tier.

   There is a **hard iteration cap** (default 3, and a caller cannot raise it —
   `--max-iterations` is clamped); there is **no automatic retry** of
   user/moderation errors.

2. **Regenerate** with the feedback applied:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/refine-dispatch.mjs" \
     --base-prompt-file <base.txt> --feedback-file <feedback.txt> \
     --iteration <N> --max-iterations 3 --repo-root "$REPO_ROOT" \
     --format png --quality <tier> [--size <WxH>] \
     [--background opaque|auto|transparent]
   ```

   It renders the base prompt + feedback into a new generation, writes a fresh
   `ImageResult` manifest (new run-id), verifies the returned file (via
   compose-dispatch), and surfaces the per-iteration cost. Past the cap it
   returns `iteration_cap` and does NOT generate.

   **`--background` is not inherited between iterations.** Restate it on every
   call: a caller that omits it gets an opaque image and a plain reason,
   rather than a policy silently carried over from a manifest nobody read.
   The transparency format policy is checked in the CLI too, so
   `--estimate-only` cannot quote a price for a run that would be rejected
   (`docs/contracts.md` §5).

3. **Loop**: critique the new image (`image:critique`); if it still fails,
   refine again within the cap, or stop and report. Lean L2 — each iteration is
   a run manifest, not durable workflow state.
