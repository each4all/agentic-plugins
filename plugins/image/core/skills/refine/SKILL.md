---
name: refine
description: "Applies critique findings or feedback and regenerates the image — the image plugin's refinement verb. Use after a critique to iterate on a generated image. Each regeneration is a new spending loop with explicit cost disclosure. Trigger phrases include 'refine the image', 'regenerate with changes', 'apply the feedback', 'fix the image', 'iterate on this', '이미지 보완', '다시 생성', '피드백 반영', '수정해서 다시'."
---

# Refine (image capability)

The image plugin's refinement verb (ADR-0010 §2, ADR-0037 Decision 1). Applies
critique/feedback and regenerates through Codex's integrated gpt-image — it
**reuses `compose-dispatch`** (the same generation + return-validation path).

## When invoked

1. **Cost gate** (`docs/contracts.md` §7): each refine is a **new generation** —
   disclose the per-iteration cost **before** regenerating. The helper computes
   it without spending:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/refine-dispatch.mjs" --estimate-only --quality low
   ```

   There is a **hard iteration cap** (default 3, and a caller cannot raise it —
   `--max-iterations` is clamped); there is **no automatic retry** of
   user/moderation errors.

2. **Regenerate** with the feedback applied:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/refine-dispatch.mjs" \
     --base-prompt-file <base.txt> --feedback-file <feedback.txt> \
     --iteration <N> --max-iterations 3 --repo-root "$REPO_ROOT" \
     --format png --quality low [--size <WxH>] \
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

3. **Privacy gate** (`docs/contracts.md` §9): genericize the revised prompt +
   feedback before cross-host dispatch — only the genericized form leaves the
   local host.

4. **Loop**: critique the new image (`image:critique`); if it still fails,
   refine again within the cap, or stop and report. Lean L2 — each iteration is
   a run manifest, not durable workflow state.
