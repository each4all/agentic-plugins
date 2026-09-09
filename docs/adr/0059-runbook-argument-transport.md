# ADR-0059: Runbook argument transport — the text reaches the CLI as a written file, and the shell never sees it

## Status

Proposed

<!--
No supersedure. This decides a mechanism the runbooks never had an explicit
contract for. It makes the guard shipped by `27a980d` unnecessary, so the
test pinning that guard must be amended in the same change.

This ADR was rewritten after cross-host review disproved its first
Decision section. The discarded design and the claims that failed are kept
in Alternatives and Consequences rather than deleted — the record of what
was refuted is the part a later reader needs most.
-->

## Context

Plugin command runbooks are markdown containing bash blocks. The host
substitutes the slash-command argument into that markdown **before the
model sees it**, so the user's verbatim text arrives as a literal inside a
shell command line, spliced unquoted:

```bash
set -o noglob
node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve <USER TEXT> \
  > "$CONTEXT_FILE" 2>"$ERR"
set +o noglob
```

A previous change (`27a980d`, shipped as `plugin-engineer` 0.21.8 and
siblings) repaired a zsh-only defect at this site — the globbing guard was
spelled `set -f`, which does not set `noglob` under zsh, so it was inert on
a zsh default shell while passing review in bash. It did not touch the
splice, which is shell-agnostic and is what this ADR decides.

### What the splice costs

The corpus is the 311 `original_request` values recorded in this
repository's own workflow state. The metric is **byte-exact round trip**,
not exit status, because the worst failure exits zero.

| transport | exact | crash | corrupt |
|---|---:|---:|---:|
| **current — unquoted splice** | **105 (33.8%)** | 127 | 79 |
| one double-quoted argument | 271 (87.1%) | 4 | 36 |
| one single-quoted argument | 198 (63.7%) | 70 | 43 |

The corrupt column is the one that matters — those parse, exit zero, and
hand the CLI a truncated topic:

```
topic:  "A 고르자; 아니면 B"
argv:   ["resolve", "A", "고르자"]        ← truncated at the semicolon
stderr: command not found: 아니면
exit:   0                                  ← nothing reports the loss
```

An apostrophe aborts the whole block, and `$(…)` executes. During this
ADR's own investigation a probe that spliced these topics into a shell line
created 16 stray zero-byte files in the repository root, because **49** of
the 311 topics contain `>` and the shell read it as redirection.

Failures are combinatorial, so no character blocklist characterises them:
with the shipped `noglob` guard active, `a (b) c`, `` a `b` c ``, `a; b`
and `a $(id) b` each pass in isolation while `a; b (c)` fails, as does the
real topic `PR3 — 미러(agents/openai.md) 추가; 검증`.

**What the corpus cannot tell us.** These 311 strings are not raw user
input. `state.mjs` records them through `singleLine(scrubSecrets(...))`,
which collapses whitespace runs, replaces line breaks and trims edges, and
they have already passed through model transcription and a successful
workflow creation. The table above is a **replay measurement on those
stored strings** and is sound as such. It is *not* the observed failure
rate of original slash-command requests, and this ADR does not use it as
one.

### Sixteen sites, four packages

`plugins/runtime` 11, `plugins/designer` 2, `plugins/engineer` 2,
`plugins/founder` 1 — with zero occurrences genuinely inside quotes. An
earlier count of fifteen came from a classifier fault: a regex testing
`"[^"]*\$ARGUMENTS[^"]*"` matched **across two separate quoted strings**,
misreading `retention.md`. A character-level quote-state tracker gives
sixteen; the cross-host review reached sixteen independently from
`plugins/engineer/commands/start.md` (`set -- $ARGUMENTS`).

Three further host-substituted placeholders sit *inside* double quotes, in
the `investigate` runbooks of engineer, designer and founder
(`--profile "${AGENTIC_PROFILE:-<profile from $ARGUMENTS>}"`). They are
template defaults rather than argv forwarding, but host text still enters
shell source there, so an acceptance check phrased as "no unquoted
variable" would miss them.

Runtime sites differ in shape: their arguments are subcommands and option
values, and several of those options **do** take prose — `context.md`
documents quoted `--summary`, `--next-action` and `--text`. Their failure
mode on a mangled argv also varies: `doctor` and `settings` exit 2,
`context`, `worktree`, `retention` and `consensus` exit 1. An earlier draft
claimed a blanket "usage line plus exit zero"; that overstated the defect.

### What the host does and does not offer

The persona parsers already accept flags followed by `--` and **one intact
body argument** — verified 4/4 exact on apostrophes, `$(id -un)`,
parentheses/semicolons/brackets and newline-plus-tab, in each of the
engineer, designer and founder libraries. **No body tokenizer is needed.**

The host does not expose the argument text in any environment variable.
It does expose it to hooks: the installed binary (2.1.266, control tokens
`PreToolUse` 107 and `SessionStart` 74 confirming the file) contains
`UserPromptExpansion` 20 and `command_args` 7. The Codex binary (control
tokens `update_plan` 48, `apply_patch` 93, `hooks` 196) contains **zero**
of either; both hosts carry `UserPromptSubmit`, which delivers the raw
prompt rather than parsed arguments. A hook transport is therefore
Claude-only on its clean path — see Decision 6.

## Decision

**1. The user text is written to a file by the model's native file-writing
tool, and never appears in a shell command line.** The runbook instructs
the model to write the argument text into a temporary file and then invoke
the CLI with a path. No shell quoting, expansion, redirection or word
splitting is involved in the capture, because no shell is.

**2. The file is versioned JSON, not raw text.** A JSON string separates
the argument's own trailing newlines from the file's formatting newline,
which raw text cannot do: a raw capture cannot distinguish an empty
argument from a single newline. The reader fails **explicitly** on
malformed encoding rather than falling back to a best guess.

**3. The CLI gains `--args-file`, and nothing else.** It decodes the file,
applies the command's documented grammar to the leading flags, and forwards
`[...flags, "--", body]` to the existing parser with the body as an exact
substring. Because the parsers already accept `--` plus one intact body, no
tokenizer is written and no existing CLI interface changes.

**4. The receiving contract is producer-independent.** `--args-file` names
a format, not a writer. Any producer that emits that format is acceptable,
which is what lets Decision 6 replace the writing step later without
touching a single consumer.

**5. Runtime commands get an explicit, non-evaluating grammar.** Their
arguments are subcommands and option values, and some option values are
prose, so enumerating the options is not sufficient — the grammar must
state how spaces, quotes and escapes inside a value decode. Anything
outside the grammar fails explicitly.

**6. Hook capture is recorded as the future producer, not adopted now.** A
Claude `UserPromptExpansion` hook persisting `command_args` is the only
design that removes model transcription of the payload, and it is a
credible architecture. It is deferred because what is proven is the
*interface*, not the *handoff*: correlating a captured payload with the
later-running runbook across concurrent commands, retries, interrupted
consumption and cleanup is unproven, a shared "latest arguments" file is
insufficient, and Codex would retain Decision 1 regardless. When that
handoff is proven, it replaces the producer and Decision 3 is untouched.
The Codex path then degrades honestly and explicitly, per ADR-0001.

**7. `engineer:start` gets its own extraction rule**, because its grammar
permits `--base-branch` to appear inside the free-text description.

**8. The shipped guard's test is amended, not replaced.**
`set -o noglob` exists to make an unquoted splice survivable; once there is
no splice it protects nothing, and
`tests/plugin-shape/test-runbook-shell-portability.mjs` asserts that a
guard survives — so it would **block this change**. Its guard-presence
assertion is replaced with transport assertions; the rest of its
portability coverage is retained.

## Consequences

**Positive.** The shell stops being part of the argument path, so the
entire class disappears rather than being mitigated — truncation,
expansion, redirection and quote termination are all properties of a shell
that is no longer there. The change is smaller than first scoped because
the parsers already take `--` plus an intact body. And the file interface
is the same one a hook producer would need, so Decision 6 costs nothing
extra later.

**Negative — and it is not claimed away.** **Model transcription remains,
and this ADR does not remove it.** The host delivers the argument text only
inside the runbook markdown, so the model reproduces it into the file. Its
fidelity was probed on eight hostile cases and four survived — NBSP,
zero-width space, CRLF and a combining mark were lost — with the case
labels naming what to look for. That probe includes display rendering and
the writing tool, so it does not isolate transcription and does not
establish a bound; it establishes that a fidelity problem exists. **No
claim of pipeline byte-exactness is made anywhere in this decision.** What
is claimed is narrower and verified: the shell stops damaging the text.

Whether that residue bites is **not** settled by this repository's corpus,
for two independent reasons: the corpus is downstream of transcription, and
it is deliberately normalised by `singleLine`. Its zero invisible
characters therefore evidence nothing about the residue in either
direction.

Other costs: sixteen runbooks change across four packages, so per-package
commits under ADR-0016 and four releases; runtime assets take effect only
once released and installed; a temporary file acquires a lifecycle whose
removal must survive early exits; and the capture step becomes a model
instruction rather than executable code, which is a real loss of
enforceability that Decision 6 is the plan to recover.

**Neutral.** The persona CLIs keep their interfaces. File-borne input
follows the precedent this repository already set with `--prompt-file` for
peer dispatch and in `companions/contract.md`: prose reaches a process as a
file, never as argv.

## Alternatives Considered

**Heredoc capture with a variable delimiter** — this ADR's own first
Decision, **dropped outright**. `<<"$DELIM"` uses the **literal string
`$DELIM`** as the delimiter, because quoting the delimiter word suppresses
its expansion. Verified in both zsh and bash: planting `$DELIM` followed by
a command in the body **executed the command** and truncated the capture.
The test that had "verified" it planted a different sentinel and passed for
the wrong reason. A second defect was hidden the same way: the heredoc
appends one LF, and the harness that reported 311/311 stripped exactly that
LF in its extractor — it normalised away the defect it was measuring.

**Heredoc capture with a fresh literal delimiter** — the repair, and still
not adopted. Mechanically the repair works: a literal quoted delimiter does
suppress all expansion, and stripping one trailing LF is an exact inverse
for text, text-plus-LF and empty. But **freshness is not absence**:
planting the actual literal delimiter still executed the control command in
both shells, and absence must be established *before* shell parsing, which
cannot be done from inside the shell. Its safety is probabilistic where
Decision 1's is structural. It also adds a second model obligation —
generating a token — on top of the transcription both designs share.

**One double-quoted argument.** Rejected on measurement: 271 of 311 exact,
36 corrupt. Double quotes still permit `$` and backtick expansion, so
`$(id -un)` executes.

**One single-quoted argument.** Rejected on measurement: 198 of 311 exact,
70 crashes; any apostrophe terminates the quoting.

**Per-token quoting by the model.** Scored 311 of 311 in a harness that
quoted *mechanically*, which is not the proposal — the proposal is for the
model to quote. Independently, splitting on whitespace and rejoining loses
whitespace structurally, failing five of eight edge cases, and the parser
joins body tokens with single spaces so the loss is unrecoverable.

**Adopting hook capture now.** Not rejected — deferred, with the reason
stated in Decision 6. An earlier draft of this ADR asserted that model
transcription was unavoidable in "every design available today"; the hook
interfaces refute that, and the assertion is withdrawn.

**Rejecting the file tool because the heredoc is machine-verifiable.** This
was the first draft's decisive argument and it is **withdrawn as
unsound**: it measured the heredoc's mechanical segment against the file
tool's model segment. Both designs have both segments, and given supplied
content, file-writing behaviour and downstream parsing are equally
mechanically testable.

## Implementation notes

Not part of the decision, but required when it lands:

- Acceptance asserts **byte-exact body preservation and absence of side
  effects**, never exit status. The 311 topics are replayed as fixtures
  through the JSON codec. Any probe that splices untrusted text into a
  shell line runs with its working directory **outside the repository** —
  the 16 stray files this investigation created are why that is written
  down.
- `tests/plugin-shape/test-runbook-shell-portability.mjs` is amended per
  Decision 8 in the change that removes the last splice, not before.
- The three quoted placeholders in the `investigate` runbooks are covered
  by the acceptance check, which is phrased against host-substituted text
  in shell source rather than against unquoted variables.
- Per-package commits under ADR-0016: `plugins/runtime` (11 sites),
  `plugins/designer` (2), `plugins/engineer` (2), `plugins/founder` (1).
  The Codex skill mirrors carry the same instructions and change with their
  packages.
- The temporary file is removed on every exit path, and the CLI's exit
  status must survive that removal — a naive `cmd; rm -f "$F"` returns the
  status of `rm`.
