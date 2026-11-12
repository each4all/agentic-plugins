# ADR-0071: Autopilot step model and effort from settings

## Status

Proposed (2026-11-12). Amends [ADR-0063](0063-autopilot-fresh-session-driver.md)
on acceptance: owner decision D5 of S8 (2026-10-01, "the model plan is asked
before each start") and open question Q4 ("model and effort defaults per
verb"), each of which carries a dated note pointing here.

## Context

An autopilot run spawns one `claude -p` worker per step, and each worker is
given a model and an effort. Since S8 that choice is one of three plans
written into the orchestrator's code (`policy.mjs`): `owner-default`,
`mixed` (the judgment verbs on the owner's default, compose and refine on
sonnet/medium, the mechanical steps on sonnet/low) and `sonnet`. Owner
decision D5 made the plan a question asked before each start, and
`--model`/`--effort` an override for every step.

Two things follow from that, and the owner's review C177 names both:

- The plans are code. An owner who wants critique on one model and commit on
  another, or a plan of their own as the default, has to edit the plugin or
  answer the question with a flag every time. The three constants are
  sensible suggestions, not configuration.
- A non-interactive start (the command runbook, a launcher) cannot start
  without a flag, because the only place a plan comes from is the question.

The runtime already owns the configuration surface for agentic-plugins:
`.agentic-plugins/config.toml`, flat keys, a repository layer over a user
layer, planned and applied with `/runtime:settings`, validated per key and
read fail-closed (`plugins/runtime/scripts/lib/runtime-config.mjs`). Its
existing `model`/`effort`/`claude_*`/`codex_*` keys are the defaults of the
cross-host peer companions (`lib/peer-execution-context.mjs`), a different
consumer with a different meaning.

## Decision

**D1. Keys.** A new runtime key family, `autopilot`, of flat keys, each one
coordinate: `autopilot_model` and `autopilot_effort` for every step, and
`autopilot_<step>_model` and `autopilot_<step>_effort` for each step a run
spawns a worker for, `<step>` one of investigate, frame, decide, compose,
critique, refine, commit, done, finalize. A dispatch counts as the verb it
dispatches, a `done --no-commit` as done; a verification step runs no model
and has no key. `/runtime:settings` derives a flag for each
(`--autopilot-compose-model`, …), and `--unset` removes them.

**D2. Validation.** An effort is one of low, medium, high, xhigh, max; a
model matches the autopilot CLI's model-name grammar. The runtime validates
on write (an invalid value is refused before anything is planned); the
orchestrator validates on read with the one check its `--model`/`--effort`
flags use. The orchestrator's reader is a copy of the runtime's contract, not
an import (ADR-0010 §5); a test holds the key lists equal and runs both
validators over the same values.

**D3. Precedence, per coordinate.** For each step, model and effort are each
taken from the first of: `--model`/`--effort`; the `--models` preset selected
(all of its row: a null in it is the owner's default, chosen, not a
fall-through); `autopilot_<step>_<coordinate>`; `autopilot_<coordinate>`
(each repository over user); the host's default. A partial flag
(`--effort high` alone) leaves the other coordinate to the settings. **The
peer-companion keys are not read**: an autopilot worker never takes `model`,
`effort` or `claude_*`, and a peer never takes `autopilot_*`. Folding the peer
keys into the chain would silently re-model the workers of every machine that
set a peer default.

**D4. Presets.** `owner-default`, `mixed` and `sonnet` stay, as one table of
suggestions (`MODEL_SUGGESTIONS`): `--models` selects one, and the start
question and the command runbook offer them. With no preset selected none is
consulted.

**D5. Snapshot.** A start resolves the run's table once — every step's model
and effort with the source of each — shows it, and records it in `run.json`
as `options.model_table`, beside `model_plan` and `model_override`. The serial
driver and the lanes scheduler read only the recorded table, so an edit to
the settings takes effect at the next run, never in the middle of one. A
caller that starts a run directly (no CLI) gets the table prepared and
validated by the start itself.

**D6. Start.** With no model flag and some `autopilot_*` key set, a start
takes the settings: a terminal start shows their table as the first choice
and the suggestions after it; any other start begins without asking. With no
key set, D5 of ADR-0063 stands: a terminal start asks, the runbook asks, and
anything else must pass a flag. A setting that cannot be read, or whose
winning value is invalid (an empty value included), refuses the start and
names the key; a flag does not route around it.

## Consequences

**Positive**: the owner sets a per-step plan once, in the same place as
every other agentic-plugins setting, and a non-interactive start uses it;
the old flags keep working; each run says what model each step ran on and
why.

**Negative**: twenty new keys, and twenty flags on the settings surfaces; a
second copy of the flat-key reader in the orchestrator, held equal by a test
rather than by an import; a broken setting now stops a start that passes a
flag.

**Neutral**: the settings writer now inserts a new key before the first
`[table]` of the file and rewrites only top-level assignments (it used to
rewrite a key inside a table and append at the end, where the reader, which
stops at the first table, did not see it). This fixes a writer defect the
plan review found and is needed for the new keys to be readable.

## Alternatives Considered

- **Fall back to the peer `model`/`effort` keys.** Rejected (D3): a different
  consumer's default; it would change the workers of every machine that set a
  peer default, without the owner choosing it.
- **One structured key** (`autopilot_models = "compose=sonnet/medium,…"`).
  Rejected: the surface is flat-key by contract, one value per key, validated
  per key, and the settings flags derive from the key list.
- **Read the settings at each step.** Rejected (D5): an edit in the middle of
  a run would change it from one step to the next, and a run would no longer
  say what it ran on.
- **Import the runtime's reader into the orchestrator.** Rejected: ADR-0010 §5
  forbids a plugin loading another plugin's code; the copy is small and held
  equal by a test.
