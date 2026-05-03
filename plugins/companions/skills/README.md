# skills/ — intentionally empty

The `companions` plugin is a **script-only library plugin** per
[ADR-0008 § (a)](../../../docs/adr/0008-companion-distribution-model.md).
It ships only `scripts/` and the two host manifests (`.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`); it does not define skills, slash commands,
hooks, or subagents.

The Codex plugin manifest declares `skills: "./skills/"` so the directory
shape matches the vendored spec at
`~/.codex/skills/.system/plugin-creator/references/plugin-json-spec.md`.
This file exists so the directory is non-empty and survives git
checkpointing.

Consumer plugins (e.g. `plugins/research/`) reach the bundled companion
scripts via cache-glob discovery — see ADR-0008 § (b) and the
companions plugin's [`README.md`](../README.md) for the discovery
algorithm.
