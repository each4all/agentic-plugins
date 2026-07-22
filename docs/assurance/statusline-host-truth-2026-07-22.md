# Statusline Host-Parity Truth Record (2026-07-22)

Pre-recorded host-parity evidence for the bootstrap/statusline/observability
track (macro `macro-plan-20260722T131932Z-73ff87`, subtask
`host-statusline-truth`). This record is the citation base for the upcoming
bootstrap-observability ADR (working id ADR-0048) and corrects the factual
basis of two `docs/ARCHITECTURE.md` statements. It records evidence only —
the ARCHITECTURE.md table itself is updated when the ADR lands, not here.

Full cited research brief (12 primary sources, capture-ordered):
`output/2026-07-22_statusline_host/research_brief.md` (session artifact,
gitignored; the citations that matter are reproduced inline below).

---

## 1. Codex CLI HAS a statusline: `[tui].status_line`

`docs/ARCHITECTURE.md:219` ("Statusline / monitors — ADAPTER (Claude only) —
Codex has no equivalent") and `:232` ("Where parity is impossible (e.g.,
statusline in Codex)") are **out of date** as of Codex CLI 0.99.0
(2026-02-11).

- Codex CLI supports `[tui] status_line = [...]` in `config.toml` — an
  **ordered list of item identifiers**. Official config reference documents
  `tui.status_line` as `array<string> | null`, "Ordered list of TUI footer
  status-line item identifiers"
  (<https://learn.chatgpt.com/docs/config-file/config-reference>).
- Introduced by PR [#10546](https://github.com/openai/codex/pull/10546)
  (merged 2026-02-05): interactive `/statusline` picker + ordered persistence
  to `config.toml`. Announced in
  [rust-v0.99.0](https://github.com/openai/codex/releases/tag/rust-v0.99.0)
  release notes (2026-02-11): "Added `/statusline` to configure which
  metadata appears in the TUI footer interactively. (#10546)".
- Item vocabulary (26 canonical kebab-case IDs at 0.145.0, defined in
  [`status_line_setup.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/tui/src/bottom_pane/status_line_setup.rs)):
  `model` (alias `model-name`), `model-with-reasoning`, `reasoning`,
  `current-dir`, `project-name` (aliases `project`, `project-root`),
  `git-branch`, `pull-request-number`, `branch-changes`, `run-state` (alias
  `status`), `permissions`, `approval-mode` (alias `approval`),
  `context-remaining`, `context-used` (alias `context-usage`),
  `five-hour-limit`, `weekly-limit`, `codex-version`, `context-window-size`,
  `used-tokens`, `total-input-tokens`, `total-output-tokens`, `thread-id`
  (alias `session-id`), `fast-mode`, `raw-output`, `thread-title`,
  `workspace-headline`, `task-progress`.
- Unset default is `["model-with-reasoning", "current-dir"]`
  ([`chatwidget.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget.rs)
  `DEFAULT_STATUS_LINE_ITEMS`); invalid item ids are tolerated with a
  once-per-session warning (PR #10546).

**Parity boundary that remains true**: PR #10546 explicitly declares "does
not introduce custom external status-line commands" a non-goal. Codex's
statusline is **item-selection** (host-rendered, closed vocabulary); Claude
Code's is **command-execution** (user script renders anything). The honest
ARCHITECTURE.md correction is therefore not "parity exists" but "both hosts
have native statuslines with different models — item list (Codex) vs shell
command (Claude)". A cross-host statusline adapter can target the shared
subset (model/reasoning, git branch, PR number, context used, 5h/weekly
limits, version) but cannot make Codex render arbitrary computed segments.

Documentation nuance: the in-repo `docs/config.md` on openai/codex main is a
726-byte pointer stub with no status_line mention — the web config reference
is canonical, and the complete item vocabulary exists only in code.

## 2. Claude Code `statusLine` execution semantics

Per official docs (<https://code.claude.com/docs/en/statusline>):

- Shape: `{"statusLine": {"type": "command", "command": <string>,
  "padding"?, "refreshInterval"? (min 1s), "hideVimModeIndicator"?}}`.
  The `command` string may be a **script path or an inline shell command**
  ("The `command` field runs in a shell, so you can also use inline
  commands instead of a script file").
- Execution: session JSON on stdin, stdout displayed; triggers are session
  start/resume, new assistant message, `/compact` finish, permission-mode
  change, vim-mode toggle, optional `refreshInterval` timer; 300ms debounce;
  in-flight run cancelled by a newer trigger.
- **Windows**: runs through **Git Bash when installed, PowerShell when Git
  Bash is absent**. Paths in `command` must use forward slashes (Git Bash
  consumes unquoted backslashes). Shell-independent pattern:
  `powershell -NoProfile -File C:/Users/<user>/.claude/statusline.ps1`.

## 3. Configured is NOT active (Claude Code)

A `statusLine` entry in settings proves configuration only. Officially
documented execution gates:

| Gate | Official statement |
|---|---|
| Workspace trust not accepted | status line command "only runs if you've accepted the workspace trust dialog"; skipped with `claude --debug` log "Status line command skipped: workspace trust not accepted" (statusline docs, Troubleshooting) |
| `disableAllHooks: true` | "the status line is also disabled" (statusline docs, Troubleshooting) |
| Safe mode | `CLAUDE_CODE_SAFE_MODE=1` "disable[s] statusLine commands from user and project settings"; agent-view background sessions default to safe mode (<https://code.claude.com/docs/en/env-vars>) |
| Script failure | non-executable script, non-zero exit, or empty stdout → blank line; slow scripts block updates; in-flight runs are cancelled (statusline docs) |

History: Claude Code 2.1.51 changelog — "Fixed a security issue where
`statusLine` and `fileSuggestion` hook commands could execute without
workspace trust acceptance in interactive mode"
(<https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>) — i.e.
the trust gate is a security boundary, and pre-2.1.51 versions had a bypass
bug. Any observability design must therefore treat "settings contain
statusLine" and "statusline actually runs" as distinct probe results.

The same trust and `disableAllHooks` gates apply to `subagentStatusLine`
(statusline docs).

## Consumption

- ADR-0048 (bootstrap observability, subtask `observability-adr`) cites this
  record for the host-parity decision input.
- The `statusline-adapter` subtask targets the shared item subset noted in
  §1's parity boundary.
- ARCHITECTURE.md:219/:232 correction ships with the ADR/integration
  subtasks, citing this record.
