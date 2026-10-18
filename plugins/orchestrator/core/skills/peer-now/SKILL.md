---
name: peer-now
description: "Dispatches a verbatim ad-hoc prompt to the cross-host companion outside Plan-verify, optionally recording a [Peer] note on the active orchestrator macro workflow. A side-channel meta operation, not a managed ensemble."
---

# Peer-Now (orchestrator meta skill)

`peer-now` sends a raw prompt to the selected peer host through
`peer-runner.mjs run --kind peer-now`. When a macro workflow is
active, it can append a `[Peer]` note to the workflow body. It never
records `pending_ensemble` or `ensemble_results`; those fields are
reserved for managed Plan-verify runs.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Ask Codex with `--peer codex` | Yes | No self-dispatch |
| Ask Claude with `--peer claude` | No self-dispatch | Yes |
| Peer-run status/cancel | Yes | Yes |
| Append `[Peer]` note | `--host claude` | `--host codex` |
| Managed ensemble bookkeeping | No — deliberately excluded | No — deliberately excluded |

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:peer-now --peer <peer> (--prompt-text ... \| --prompt-file <path>)` | `$orchestrator:peer-now --peer <peer> (--prompt-text ... \| --prompt-file <path>)` |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | For a mentioned `orchestrator` skill, the plugin directory that contains it: Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/orchestrator/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/orchestrator` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Host flag for state note | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake

Require:

- `--peer claude|codex`
- Exactly one of `--prompt-text` or `--prompt-file`

Reject self-dispatch, missing prompt, duplicate prompt forms, or an
unreadable prompt file.

The prompt reaches the runner as a file, never as shell source (ADR-0059,
amendment of 2026-10-10): a prompt or a path spliced into a command line is
cut at `;`, expanded at `$(…)` and run at a backtick. Create a private
directory (`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`, noting the path
it prints) and write one file there with your file-editing tool: for
`--prompt-text`, `prompt.xml` holding the prompt exactly as given; for
`--prompt-file <path>`, `prompt-path.txt` holding that path on one line, so
the runner reads the user's file itself, byte for byte. Nothing deletes the
files.

---

## Phase 1 — Dispatch

A codex peer answers from a snapshot of the checkout, removed when the
run ends (C96): a file it writes is discarded with it. Ask it for an
answer, not for files.

```bash
TEXT_DIR='<directory from mktemp>'
PEER='<claude|codex>'
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# The prompt: the file prompt-path.txt names (--prompt-file), or the
# prompt.xml written for --prompt-text. The path is data cat read, never
# shell source.
PROMPT_FILE="$TEXT_DIR/prompt.xml"
if [ -f "$TEXT_DIR/prompt-path.txt" ]; then PROMPT_FILE="$(cat "$TEXT_DIR/prompt-path.txt")"; fi
[ -s "$PROMPT_FILE" ] || { echo "✗ The prompt file ($PROMPT_FILE) is missing or empty; nothing was dispatched." >&2; exit 1; }
# For Phase 2, which may run in a fresh shell: the peer, and the run's result.
printf '%s' "$PEER" > "$TEXT_DIR/peer" || exit 1
node "<plugin-root>/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" \
  --run-id "$RUN_ID" \
  --kind peer-now \
  --peer "$PEER" --prompt-file "$PROMPT_FILE" \
  --output-format text \
  --host <claude|codex> \
  --cwd "$REPO_ROOT" \
  > "$TEXT_DIR/run.json" 2> "$TEXT_DIR/run.err"
```

The runner writes a ledger under
`.agentic-plugins/state/orchestrator/peer-runs/<run_id>/` for new repos
(or the legacy peer-run home until explicit migration), and its result —
`run_id`, `status`, the ledger's paths — to `run.json` in the text directory.
On a non-zero exit, surface the first useful line of `run.err` with the run
id, and stop without writing workflow state. Use `peer-runner.mjs status` and
`peer-runner.mjs cancel` for operational control.

---

## Phase 2 — Optional workflow note

Locate the active macro first. The block prints its path, or nothing, and
writes the same to `macro-path` in the text directory: the note block reads it
there, so a branch switched between the two blocks cannot point the note at
another macro.

```bash
TEXT_DIR='<directory from mktemp>'
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit 1
printf '%s' "$ACTIVE" > "$TEXT_DIR/macro-path" || exit 1
printf '%s\n' "$ACTIVE"
```

When it found one active macro, append a note. The block reads the macro the
lookup found, and builds `$NOTE` as `commands/peer-now.md` Phase 2
builds it, from values programs read or printed only: `peer`, `run_id` and
`handle` lines from the peer Phase 1 wrote and the run's JSON, then the first
4000 bytes of the response as `head -c 4000 "$STDOUT_PATH"` reads them. Never
write the response, or any other text, into the block yourself; an
expansion's result is not evaluated again, a block's source is.

```bash
TEXT_DIR='<directory from mktemp>'
# The macro the lookup found, not the one this branch names now.
ACTIVE="$(cat "$TEXT_DIR/macro-path")" || { echo "✗ The lookup writes the macro it found to $TEXT_DIR/macro-path: run it first; nothing was recorded." >&2; exit 1; }
[ -n "$ACTIVE" ] || { echo "✗ The lookup found no active macro: print the response alone; nothing was recorded." >&2; exit 1; }
PEER="$(cat "$TEXT_DIR/peer")" || exit 1
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
RUN_ID="$(JSON_KEY=run_id node -e "$JSON_FIELD" < "$TEXT_DIR/run.json")" || exit 1
HANDLE_PATH="$(JSON_KEY=handle_path node -e "$JSON_FIELD" < "$TEXT_DIR/run.json")" || exit 1
STDOUT_PATH="$(JSON_KEY=stdout_path node -e "$JSON_FIELD" < "$TEXT_DIR/run.json")" || exit 1
[ -n "$STDOUT_PATH" ] || { echo "✗ The run recorded no response file ($TEXT_DIR/run.json); nothing was recorded." >&2; exit 1; }
RESPONSE="$(head -c 4000 "$STDOUT_PATH")"
NOTE="peer: $PEER
run_id: $RUN_ID
handle: $HANDLE_PATH
prompt-mode: verbatim

### Response

$RESPONSE
"
node "<plugin-root>/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host <claude|codex> \
  --phase-label "[Peer] $PEER consultation" \
  --phase-note "$NOTE" \
  --event updated
```

Do not pass `--current-phase`, `--next-action`, or managed ensemble
bookkeeping flags. Print the peer response verbatim in every success
case.

---

## Anti-patterns

- Do not use peer-now for Plan-verify.
- Do not write peer-now results into `ensemble_results`.
- Do not synthesize the raw peer response unless the user separately
  asks.
- Do not mutate macro phase or subtask status.
