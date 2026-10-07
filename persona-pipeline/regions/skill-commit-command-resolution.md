| Concern | Claude | Codex |
|---------|--------|-------|
| Plugin root | Each shell block of the Claude command sets `$CLAUDE_PLUGIN_ROOT` first: from `{{root_env}}` when set, else from the plugin path Claude Code writes into the command body when it loads it, else from the newest release (`X.Y.Z`) under `~/.claude/plugins/cache/agentic-plugins/{{persona}}/` | For a mentioned `{{persona}}` skill, the plugin directory that contains it (inside `${{persona}}:start`, the mentioned skill is `start`, which runs the six verb skills in place): Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/{{persona}}/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/{{persona}}` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Entry path | `/{{persona}}:commit` | `${{persona}}:commit` — this SKILL.md is the runbook |
| `--host` | `claude` | `codex` |

Every block below is the Claude command's block, with `<plugin-root>` for the
plugin root and `<claude|codex>` for the host, and resolves the workflow
again: a shell variable does not outlive a Bash call.
