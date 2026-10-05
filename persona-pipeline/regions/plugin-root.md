Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `{{root_env}}` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
