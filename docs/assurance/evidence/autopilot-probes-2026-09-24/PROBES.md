# Live probe log — autopilot feasibility

> **Relocated 2026-09-29** from the owner's handoff package, where it was
> `evidence/PROBES.md`. It is the host-truth record behind
> [ADR-0063](../../../adr/0063-autopilot-fresh-session-driver.md).
> - The probe scripts are in `scripts/` beside it; see the directory's README.
> - `prototype/…` and `plugin-changes …` refer to files that stayed in that package.
> - The text below is kept as written. Two findings have changed since, and the
>   directory README explains both:
>   - V0's end state relied on orchestrator 0.13.7 completing a subtask at its
>     commit. ADR-0062 changed that.
>   - The `rm` denial count predates ADR-0059's cleanup trap.

- Date: 2026-09-24
- Host: macOS (Darwin 27.0.0), Claude Code **2.1.281**
- Installed plugins: orchestrator 0.13.7, engineer 0.21.10, runtime 0.97.4, attention 0.9.0, companions 0.4.1.

Every probe ran in throwaway git repos under the session scratchpad. None touched the
agentic-plugins checkout or user config. Launches went through
`scripts/clean-claude.sh`, which strips the launching session's identity env and
`AGENTIC_NOTIFY_EGRESS_CHANNEL`, so no phone notifications were sent. Streams were
read through `scripts/summarize.mjs`.

User config at probe time (`~/.agentic-plugins/config.toml`):
- `notify_channel = "none"`
- `notify_kinds = "approval,response-needed"`
- `entry_brief = "startup"`
- `session_capture = "stop-hook"`

Egress was active through the environment only.

## Summary

| id | question | result | design impact |
|----|----------|--------|---------------|
| A1 | Can `claude -p` start from inside a Claude session (inherited `CLAUDECODE`, …)? | ✓ exit 0 | The driver can be launched by a slash command, not only from a terminal |
| A2 | Same, with a clean env (plain-terminal equivalent) | ✓ exit 0 | Terminal launcher works |
| A | Do plugins load under `-p`? | ✓ all agentic-plugins load; 128 slash commands registered, incl. `orchestrator:next` and `engineer:compose` | No `--plugin-dir` needed |
| A | Do hooks fire under `-p`? | ✓ SessionStart:startup, UserPromptSubmit, Stop (engineer, orchestrator, attention) | Existing Stop writeback runs inside each worker |
| A | Is the entry-brief injected? | ✓ The attention SessionStart hook emitted `[agentic-entry-brief] {schema: runtime-entry-brief-1.0, disposition: lead, …}` | Workers see the oracle line |
| A | Is AskUserQuestion available? | ✗ absent from the tool list under `-p` in every run (`askUser=false`) | Judgment requests must go to durable state (`awaiting_owner`) |
| A | Is usage visible per message? | ✓ `message.usage` on every assistant event; `result.modelUsage.<model>.contextWindow` | Context sensor is feasible |
| A | Fresh-session baseline | haiku ≈ 22.7K tokens; sonnet + plugin runbook ≈ 38–43K | — |
| A | Stdin | Without `< /dev/null` (or a pipe), `-p` waits 3 s for stdin and warns | The driver always pipes stdin |
| B | Does a plugin slash command execute under `-p`, auto mode? | ✓ `/orchestrator:resume` ran its runbook to the correct guard ("no active workflow"), 5 turns, $0.24 (sonnet/medium) | — |
| B | Is `$CLAUDE_PLUGIN_ROOT` set in runbook Bash? | ✗ unset. The model searched `~/.claude/plugins/cache/...`, first chose a version-less path, then 0.13.7 | The driver must inject plugin roots |
| D | Does a background Bash task survive the end of a `-p` turn? | ✗ killed: `sleep 20 && echo DONE` never wrote its marker, and no leftover process remained | `-p "<prompt>"` loses peer ensembles run in the background |
| D2 | Same, with `--input-format stream-json` and stdin held open | ✓ The task completed, a `system/task_notification` arrived, the model was re-invoked (second `result`), and the marker was written | The driver hosts sessions over stream-json and closes stdin only when a result has arrived and no background tasks remain |
| P1 | `--permission-mode auto --permission-prompts none` on haiku | init showed `permissionMode=default` (auto falls back on haiku). The compound block was **denied**: "no approval surface … denied automatically" | — |
| P3 | haiku, auto (effectively default) + `--allowedTools Bash` | ✓ allowed | — |
| P4 | sonnet, `--permission-mode manual --allowedTools Bash --permission-prompts none` | ✓ allowed (`permissionMode=default`) | **Deterministic posture: manual + allowlist + denylist + prompts none** |
| P5 | sonnet, `--permission-mode auto --allowedTools Bash` | ✓ allowed this simple block. The same kind of block was denied inside the real runbook in E4 and E7 | Auto mode is classifier-driven and nondeterministic; do not use it for the driver |
| E | Full ADR-0019 chain across fresh processes | ✓ with 3 driver-side mitigations (details below) | — |
| J1 | `--json-schema` with `--input-format stream-json` (haiku, plain prompt) | ✓ The model calls a `StructuredOutput` tool at the end, and `result.structured_output` carries the validated object | Workers can return a machine-readable step report |
| J2 | Same, with a plugin slash command as the stream-json user message (`/orchestrator:resume`, sonnet, manual + allowlist) | ✓ The command expanded, the runbook ran (3 Bash calls), then `StructuredOutput`; `structured_output` was present | Slash commands work over stream-json input; step reports work with runbooks (prototype SHIM-1) |
| W1–W5 | Which Bash commands are still denied under `manual` + `--allowedTools Bash` + prompts none (haiku)? Found because `/orchestrator:plan` hit one denial in the validation run | W1 redirect to `$TMPDIR` ✓. V1–V4 `cd <repo> && …`, `export CLAUDE_PLUGIN_ROOT=…`, multi-line ✓. **W2/W3 any `rm -f "$F"` ✗ denied**, both inside the repo and in `$TMPDIR`. **W5: an explicit `Bash(rm:*)` allow does not lift it** | The first reading ("built-in protected command") was **wrong**; see R1/R2. Runbook shell blocks must still not use `rm`; see plugin-changes §1.6a |
| R1/R2 (2026-09-25) | Is the `rm` denial Claude Code's own protection, or the owner's settings? | R1, same `rm` block with `--setting-sources project,local` (user settings excluded): ✓ **allowed**, but init plugins = `agents-md, telemetry` only (no agentic plugins, because `enabledPlugins` lives in user settings). R2, user settings loaded: ✗ denied | Cause: the owner's `permissions.ask` includes `Bash(rm:*)` (also `sudo`, `git push -f/--force`, `git reset --hard`). Headless ask means auto-deny. Workers must load user settings, so these ask rules always apply to them |
| T | Tool names inside a `-p` worker (init `tools`) | The subagent tool is `Task` (interactive sessions call it `Agent`). `PushNotification`, `RemoteTrigger`, `CronCreate`, `ScheduleWakeup`, `SendMessage`, `EnterWorktree` and `Workflow` are also present | Allowlist `Task`; deny the scope-escaping tools |

## Probe E: end-to-end chain (sonnet, `--effort medium`, auto + prompts none)

Goal given to the planner: "Add a tiny greet CLI (greet.mjs printing "Hello,
<name>") and a README usage section documenting it".

| run | command | time | cost | peak ctx (of 1M) | outcome |
|---|---|---|---|---|---|
| E1 | `/orchestrator:plan <goal>` | 25 s | $0.13 | 43.7K (4.4%) | Model refused ("too small for orchestrator:plan"), asked a question, **wrote no state** |
| E2 | plan + "do not downscope" | 284 s | $0.57 | 65.0K (6.5%) | Macro with subtasks `greet-cli` (compose/backend) and `greet-docs` (compose/docs, blocked_by greet-cli). Codex plan-verify ran as a background task and the turn waited. Ended with a HIGH proposal for `/orchestrator:next` **without stopping for approval** |
| E3 | `/orchestrator:next` | 39 s | $0.16 | 50.0K | A compound block was denied; the model gave up and asked. No state change |
| E4 | `/orchestrator:next` + `--allowedTools Bash` | 167 s | $0.56 | 72.4K (7.2%) | Branch `feat/greet-cli` created. Engineer workflow created with `parent_workflow` / `originating_subtask`; greet.mjs written; Phase 4 `in_progress`. The model split Phase 0 into separate calls after a denial |
| E5 | `/engineer:critique` | 32 s | $0.12 | 43.7K | `CLAUDE_PLUGIN_ROOT` empty; the model concluded "plugin not installed" and did an informal review. **No state change** |
| E6 | `/engineer:critique` (repeat) | 24 s | $0.12 | 43.2K | Same as E5 |
| E7 | critique + plugin-root hint (`--append-system-prompt-file`) | 242 s | $0.64 | 67.9K | Full runbook. Codex peer ran in the background and the turn waited. `ensemble_results` verdict=concerns (1 MINOR). Proposal: commit HIGH |
| E8 | "Commit the work of the active engineer workflow…" + hint | 16 s | $0.10 | 40.5K | Local commit via plain git. **Its own Stop archived the engineer workflow and wrote back `completed`**; greet-docs unblocked. Warning: `conventional_commit:non_conventional_subject` |

Totals: 8 runs, $2.40. The four productive runs cost $1.87.

### Oracle views between runs

The fields below are entry-brief `disposition` → `leading.source` / `state` → `command`.

- **Before E1:** owner-choice-required, no rows.
- **After E1:** lead entry-capture/fresh → `/runtime:context status --slot`. The slot came from E1's own Stop (session_capture=stop-hook).
- **After E2 and E3:** lead macro-active/active → `/orchestrator:resume`. The macro sits on its own branch (row 16.2), and next-ready returned greet-cli.
  - Macro: `current_phase=phase-2-presented`, `next_action="Await user approval of macro plan; …"`.
- **After E4–E7:** lead entry-capture/fresh → `/runtime:context status --slot`.
  - Rows: macro-bridge in_progress_or_blocked, persona-workflow **terminal**.
  - After compose the engineer workflow already had `terminal_marker=true`, `current_phase=summary-complete`.
  - The next verb existed only as free text: `next_action="Critique the composed artifact"`.
- **After E8:** lead macro-bridge/ready → `/orchestrator:next` (row 16.3), and next-ready returned greet-docs.
  - The macro was still `phase-2-presented`. Approval is never recorded.

### ADR-0019 chain links across separate processes

| link | result |
|---|---|
| dispatch linkage (`parent_workflow`, `originating_subtask`) | ✓ |
| Phase 4 `subtask-update in_progress` | ✓ |
| reattach (append-on-resume) | ✓ |
| Stop writeback + engineer archive + unblock | ✓ in the committing worker's own Stop |
| macro phase | stale (never leaves `phase-2-presented`) |

### Blockers for a zero-human driver on current code

1. The next verb is not in structured state. After a verb the workflow reads terminal/summary-complete, so the oracle leads elsewhere.
2. Plan approval is not durable, and `/orchestrator:next` does not check it.
3. Judgment requests (E1 scope refusal) leave no state.
4. Auto-mode permissions are nondeterministic for runbook blocks.
5. Plugin-root resolution is nondeterministic without an injected hint.
6. Runs can exit 0 with no state change (E3, E5, E6), so no-progress detection is mandatory.
7. Commit discipline: `terminal_marker` is already true after compose, so a commit during compose closes the subtask before critique. There is no verb-chain commit runbook.

## V0: prototype driver end-to-end (2026-09-24)

The handoff package's `prototype/autopilot.mjs` was run on a fresh scratch repo.
- The macro was created by a headless `/orchestrator:plan`: 163 s, $0.40, 1 `rm` denial.
- It has two subtasks: `greet-cli` (code), then `greet-readme` (docs, blocked_by greet-cli).
- The plan was approved through the SHIM-2 approval file.
- The driver ran with `run --model sonnet --effort medium --max-steps 14 --max-cost 15 --step-budget 4`.

| step | command | subtask | time | cost | peak ctx (of 1M) | denials | report |
|---|---|---|---|---|---|---|---|
| 1 | `/orchestrator:next` | greet-cli | 367 s | $1.38 | 102K (10.2%) | Bash (rm), Monitor | verb:compose@HIGH (the dispatch ran compose with the plan profile + plan-verify ensemble) |
| 2 | `/engineer:compose` | greet-cli | 206 s | $0.49 | 60K (6.0%) | Bash (rm) | verb:critique@HIGH |
| 3 | `/engineer:critique` | greet-cli | 206 s | $0.82 | 87K (8.7%) | Bash (rm) ×2 | commit@HIGH |
| 4 | commit step (SHIM-4) | greet-cli | 16 s | $0.11 | 37K (3.7%) | — | done@HIGH → Stop archived + wrote back |
| 5 | `/orchestrator:next` | greet-readme | 217 s | $0.71 | 74K (7.4%) | Bash (rm) | verb:critique@HIGH |
| 6 | `/engineer:critique` | greet-readme | 142 s | $0.46 | 67K (6.7%) | Bash (rm) | commit@HIGH |
| 7 | commit step | greet-readme | 15 s | $0.11 | 35K (3.5%) | — | done@HIGH |
| 8 | `/orchestrator:finalize` | — | 67 s | $0.25 | 51K (5.1%) | Bash (rm) | done@HIGH → macro archived |

**Result: `completed`, with zero human input after approval.**
- 8 fresh sessions, $4.33, 20.6 min.
- Peak context per step ≤ 10.2%.
- End state:
  - two Conventional Commits (`feat(cli): add greet.mjs greeting script`, `docs(readme): add usage instructions for greet.mjs`);
  - clean tree, no push;
  - `node greet.mjs World` prints `Hello, World`;
  - the macro and both engineer workflows are under `state/*/archive/`.

Findings:
- **Every Bash denial (7 of 7) was a runbook block containing `rm`.** plugin-changes
  §1.6a removes all of them.
- **One `Monitor` denial.** The model wanted to wait on its peer run, so `Monitor`
  was added to the allowlist.
- **The oracle blind spot reproduced.** While a subtask was mid-chain, entry-brief
  led `/runtime:context status --slot` (steps 2, 3, 4, 7). The driver did not
  depend on it: next-ready plus the step report (SHIM-1) carried every decision.
- **The dispatch step was the most expensive** ($1.38 and $0.71), because of the
  plan-verify ensemble inside compose. The commit steps were the cheapest.

## V0b: halt paths (2026-09-24)

A second scratch repo was set up with an unapproved two-subtask macro, created by
a headless `/orchestrator:plan`: 293 s, $0.62, 1 `rm` denial. The script is
`scripts/halt-tests.sh`.

| id | scenario | result |
|---|---|---|
| N1 | run before approval | `plan-unapproved` ✓ |
| N2 | approval hash no longer matches the plan | `plan-unapproved — plan changed since approval` ✓ |
| N3 | untracked file before a dispatch | `dirty-tree — ?? untracked.txt` ✓ |
| N4 | `.lock` held by a live pid | refused: "another autopilot run holds …" ✓ |
| N5 | worker told to do nothing (haiku) | `no-progress` ✓. The model still self-reported `next=verb:investigate@HIGH`; the fingerprint guard caught the wrong report |
| N6 | worker reports `awaiting_owner=decide-conflict` without changing state | `awaiting-owner:decide-conflict` ✓. The explicit signal wins over no-progress |
| N7 | re-run after N6 with nothing changed | halts again with `awaiting-owner:decide-conflict` ✓ (sticky until state changes) |
| N8 | owner overrides with `--next "/orchestrator:next"` | proceeds ✓ |

Unit tests (handoff package): `node --test prototype/test/autopilot.test.mjs` → 18/18 pass (policy
15, stream-json host 3, using a fake `claude`).

## Other observations

- **Scratch repo needed a gitignore.** It had to ignore `.agentic-plugins/{runs,state,tmp,cache}/`; otherwise session-capture writes dirty the tree and trip next's clean-tree gate.
- **The owner's user-level hook `cc-status` (iTerm2) errors headless.** It fails with "No such session" on SessionStart, UserPromptSubmit and Stop. The errors don't block.
- **Several cached plugin versions coexist.** orchestrator 0.13.5–0.13.7, engineer 0.21.8–0.21.10, runtime 0.97.1–0.97.4. A model resolving roots by itself may pick any of them.
- **Useful stream signals for a driver:**
  - `system/hook_response`, including the ADR-0031 `archive_gate=blocked|ready_to_archive` line;
  - `system/permission_denied`;
  - `system/background_tasks_changed`, `system/task_notification`;
  - per-message `usage`;
  - `result.permission_denials`, `result.total_cost_usd`, `result.modelUsage`.

## Reproduce

```bash
# From a scratch git repo:
"$D/scripts/clean-claude.sh" -p "Reply with exactly: PONG" \
  --model haiku --output-format stream-json --verbose --include-hook-events \
  --max-budget-usd 0.5 < /dev/null > a.jsonl
node "$D/scripts/summarize.mjs" a.jsonl
```

Stream-json hosting (D2 pattern):

```bash
MSG='{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}'
( echo "$MSG"; sleep 45 ) | clean-claude.sh -p --input-format stream-json \
  --output-format stream-json --verbose --model haiku --allowedTools Bash > d2.jsonl
```
