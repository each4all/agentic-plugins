---
name: decide
description: "Chooses among candidate approaches, styles, or generated image variants under the brief's constraints — the image plugin's decision verb. Use to pick a direction or select the best variant from a multi-image generation. Trigger phrases include 'which variant', 'pick the best image', 'choose a style', 'compare these images', 'which one', '어떤 변형', '어떤 이미지', '베스트 골라', '스타일 선택'."
---

# Decide (image capability)

The image plugin's decision verb (ADR-0010 §2, ADR-0037 Decision 1). Chooses
among candidate approaches, styles, or generated variants under the brief's
constraints — variant selection is core to quality-first image work.

## When invoked

1. **Evaluate** candidates against the brief's `success_criteria` + constraints
   (`docs/contracts.md` §3). decide does **not** visually evaluate generated
   variants itself — for a per-variant visual assessment, run `image:critique`
   on each candidate first, or select from existing critique / user-visible
   evidence. Enumerate candidates with a zero-based index + path + metadata
   (read `manifest.images[]` and `manifest.cost`) before selecting.

2. **Select** a generated variant — record it in the run manifest:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/variant-select.mjs" \
     --manifest-file <run-dir>/manifest.json --select <index>
   ```

   Marks `images[index].selected=true` and the rest `rejected=true`.

3. **Retention / cleanup** (`docs/contracts.md` §7): rejected variants are kept
   as **audit artifacts by default**. Cleanup is **explicit, never automatic**:
   - **List first** — show the exact rejected variant paths and get explicit
     user confirmation before pruning.
   - **Then prune**:
     ```bash
     node "$CLAUDE_PLUGIN_ROOT/scripts/variant-select.mjs" \
       --manifest-file <run-dir>/manifest.json --prune-rejected
     ```
   - Prune deletes ONLY rejected, non-selected **image variants**
     (png/jpeg/webp), and ONLY when their real path resolves inside the real run
     dir (symlinked parents cannot escape). It never touches `manifest.json` /
     `brief.json` / `prompt.txt`.

4. Surface the selection + `manifest.cost` already spent. Cleanup does **not**
   refund spend. Do NOT regenerate to pick — that's `image:refine`. Lean L2 —
   selection lives in the run manifest, not durable workflow state.
