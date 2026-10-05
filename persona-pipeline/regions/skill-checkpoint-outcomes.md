- `✓ Checkpoint recorded: <summary>` — Phase 2 succeeded. Surface the
  absolute workflow path so the user can inspect by hand.
- `✗ No active workflow; nothing to checkpoint.` — Phase 1 found nothing.
- `✗ Per-branch duplicate detected — resolve via the resume meta skill
  before checkpointing.` — Phase 1 found more than one workflow.
- `✗ Empty summary; <command-or-skill-name> <summary> required.` — Phase 0
  rejected.

On Claude, the next SessionStart re-injects the summary into the
post-compact session as part of the `[{{persona}}-active-metadata]` marker — no
need to re-issue `resume` inside that window. The on-disk
`latest_checkpoint` is host-agnostic, so a checkpoint written on either host
is read by either host; Codex re-injects it the same way once the plugin's
hooks are enabled and `/hooks`-trusted, per the Host availability table.
Outside the post-compact window, `resume` reads it manually.
