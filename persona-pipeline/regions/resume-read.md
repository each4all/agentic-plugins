```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE" >/tmp/{{name}}-resume-read.json
CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
BASE_BRANCH="$(node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git_baseline||{};process.stdout.write(String(b.branch??""))}catch{}' /tmp/{{name}}-resume-read.json)"
BASE_HEAD="$(node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git_baseline||{};process.stdout.write(String(b.head??""))}catch{}' /tmp/{{name}}-resume-read.json)"
BASE_DIGEST="$(node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git_baseline||{};process.stdout.write(String(b.status_digest??""))}catch{}' /tmp/{{name}}-resume-read.json)"
```
