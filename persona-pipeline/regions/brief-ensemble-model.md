Model and effort are NOT passed via flags — the peer runs with the model
and effort its host is configured with, and the user's peer-host
configuration is the single source of truth. (`companions/contract.md`
§ 2.2 makes `--model` / `--effort` optional; {{persona}}'s always-max policy,
which dispatches the peer every time, declines to override them at the
protocol layer, so it never raises the peer's effort.)
