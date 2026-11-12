"Always-max" names how often the peer is called, not how hard it works:
the peer call runs with the model and effort its host is configured
with. Skills do **not** pass `--model` or `--effort` flags, so nothing
raises the peer to a maximum effort or depth — each host's config file
(`~/.codex/config.toml`, `~/.claude/settings.json`, etc.) is the single
source of truth.

`Ensemble Affinity` (LOW / MEDIUM / HIGH) is retained as a Task Profile
axis (records context about the task) but does **not** gate dispatch.
