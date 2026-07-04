# skills/ — deliberately empty (Codex manifest-spec placeholder)

The `attention` plugin is a **hook-only Layer 1 plugin** per
[ADR-0040 §3](../../../docs/adr/0040-operator-observability.md) — it ships
hooks + sensor scripts only: no skills, no verbs, no state machinery. It is
the hook-bearing sibling of the ADR-0008 script-only library shape.

This directory exists solely because the Codex vendored plugin spec requires
the `skills` field in `.codex-plugin/plugin.json` to point at a real
directory. Per the
[ADR-0008](../../../docs/adr/0008-companion-distribution-model.md) §Codex
spec compliance carve-out (established for `plugins/companions`), a
non-skill-bearing plugin MAY ship an empty `skills/` directory containing
only this placeholder README. The placeholder does not disqualify the plugin
from the hook-only category — the shape qualifier prohibits **functional**
skills content (a `SKILL.md` directory under `skills/<name>/`), not the empty
directory required by Codex's manifest schema.
