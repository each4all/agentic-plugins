# ADR-0059: Runbook argument transport — user text stops being shell syntax, and the residual that stays is named

## Status

Proposed

<!--
No supersedure. This decides a mechanism the runbooks have never had an
explicit contract for. It replaces the guard shipped by `27a980d`
(ADR-less fix) with a boundary that makes that guard unnecessary, and it
therefore requires replacing the test that guard added.
-->

## Context

Plugin command runbooks are markdown containing bash blocks. The host
substitutes the slash-command argument variable into that markdown
**before the model sees it**, so the user's verbatim text arrives as a
literal inside a shell command line, spliced unquoted:

```bash
set -o noglob
node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve <USER TEXT> \
  > "$CONTEXT_FILE" 2>"$ERR"
set +o noglob
```

A previous change (`27a980d`, shipped as `plugin-engineer` 0.21.8 and
siblings) fixed a zsh-only defect at this site: the globbing guard was
spelled `set -f`, which does not set `noglob` under zsh, so it was inert
on a zsh default shell while passing every review in bash. That change
did not touch the splice itself, which is shell-agnostic and is what this
ADR decides.

### What the splice costs, measured

The corpus is the 311 `original_request` values recorded in this
repository's own workflow state — real topics, not constructed ones. The
metric is **byte-exact round trip**, not exit status, because the failure
that matters most exits zero.

| transport | exact | crash | corrupt |
|---|---:|---:|---:|
| **current — unquoted splice** | **105 (33.8%)** | 127 | 79 |
| quoted heredoc → args-file | **311 (100%)** | 0 | 0 |
| one double-quoted argument | 271 (87.1%) | 4 | 36 |
| one single-quoted argument | 198 (63.7%) | 70 | 43 |
| per-token quoting | 311 (100%) | 0 | 0 |

An earlier count of this defect used "does the block fail" as the metric
and reported 41.9% safe. That was too generous by 79 topics: those parse,
exit zero, and deliver a **corrupted** topic. The measured example:

```
topic:  "A 고르자; 아니면 B"
argv:   ["resolve", "A", "고르자"]        ← truncated at the semicolon
stderr: command not found: 아니면
exit:   0                                  ← nothing reports the loss
```

The decision then proceeds on the truncated topic. Two further modes were
measured: an apostrophe (`I don't know`) aborts the whole block, and
`$(…)` executes — during this ADR's own investigation a probe that
spliced these topics into a shell line created 16 stray zero-byte files
in the repository root, because 34 of the topics contain `>` and the
shell read it as redirection.

Failures are **combinatorial**, which is why a character blocklist cannot
fix this. With the shipped `noglob` guard active, `a (b) c`, `` a `b` c ``,
`a {b} c`, `a |b c`, `a & b`, `a; b`, `a $(id) b` and `a [b] c` all pass in
isolation; `a; b (c)` fails, and so does the real topic
`PR3 — 미러(agents/openai.md) 추가; 검증` with `command not found: 검증`.

### Two premises this ADR started with, both refuted

**"The CLI cannot accept the arguments as one argument."** True only of
the whole flags-plus-body string, which becomes the value of `--preset=`.
The persona parsers already accept flags followed by `--` and **one
intact body argument**; verified here with a 4/4 exact round trip on
apostrophes, `$(id -un)`, parentheses/semicolons/brackets, and
newline-plus-tab. **No body tokenizer is needed** — only the body
delivered intact. This materially shrinks the change.

**"A heredoc keeps the host's bytes untouched by the model."** False. The
host exposes the argument text only inside the runbook markdown; no
environment variable carries it (the session's whole `CLAUDE_*` key set
was checked). The model therefore transcribes the text into whatever tool
call it makes, in every candidate. Transcription is a **shared ceiling,
not a discriminator** — see Consequences.

### The site inventory, and a correction to it

Sixteen unquoted splices inside bash blocks, across four release-please
packages:

| package | sites |
|---|---:|
| `plugins/runtime` | 11 |
| `plugins/designer` | 2 |
| `plugins/engineer` | 2 |
| `plugins/founder` | 1 |

An earlier count said fifteen. The classifier was wrong: a regex testing
`"[^"]*\$ARGUMENTS[^"]*"` matched **across two separate quoted strings**,
so `node "…/retention.mjs" $ARGUMENTS --repo-root "$REPO_ROOT"` was
misread as quoted. A character-level quote-state tracker gives sixteen,
with **zero** occurrences genuinely inside quotes. The cross-host review
reached sixteen independently, from `plugins/engineer/commands/start.md`
(`set -- $ARGUMENTS`) rather than from `retention.md`.

The runtime sites differ in shape: they take subcommands and option
values rather than a free-form body, and a mangled argv there makes the
CLI print a usage line and **exit zero**.

## Decision

**1. User text is captured as data before any shell parsing, and is never
part of a command line.** Each affected runbook writes the
host-substituted text into a temporary file through a **quoted heredoc**,
and the CLI receives a path rather than words:

```bash
ARGS_FILE="$(mktemp -t agentic-args.XXXXXX)"
DELIM="AGENTIC_ARGS_EOF_$(basename "$ARGS_FILE" | tr -dc 'A-Za-z0-9')"
cat > "$ARGS_FILE" <<"$DELIM"
<HOST-SUBSTITUTED TEXT>
$DELIM
node "$CLAUDE_PLUGIN_ROOT/scripts/<cli>.mjs" <subcommand> --args-file "$ARGS_FILE"
rm -f "$ARGS_FILE"
```

The quoted delimiter is what does the work: inside `<<"$DELIM"` the shell
performs no expansion of any kind. Measured exact in **both zsh and bash**
on a planted delimiter collision, `$HOME`, `$(id -un)`, backticks,
newline-plus-tab, unicode and mixed quotes.

**2. The delimiter is derived per invocation from `mktemp`, not fixed.**
The cross-host review's condition for accepting a heredoc was a delimiter
"chosen after substitution, verified absent as a complete input line". A
fixed sentinel cannot satisfy it; one derived at run time from the
temporary filename does, and was measured against a planted collision
with the fixed sentinel.

**3. The CLI gains `--args-file`, and nothing else.** It reads the file,
applies the command's documented grammar to the leading flags, and
forwards `[...flags, "--", body]` to the existing parser with the body as
an **exact substring**. Because the parsers already accept `--` plus one
intact body, no tokenizer is written and no existing CLI interface
changes.

**4. Runtime commands get an explicit, non-evaluating grammar.** Their
arguments are subcommands and option values, not prose. The reader
enumerates the accepted subcommands and options and **fails explicitly**
on anything else, rather than forwarding an unrecognized string. A usage
line plus exit zero is not an acceptable outcome for a malformed
invocation.

**5. `engineer:start` gets its own extraction rule.** Its grammar permits
`--base-branch` to appear inside the free-text description, so the
generic leading-flags rule would mis-split it. Its rule is written and
tested separately.

**6. The transcription ceiling is stated, not claimed away.** See
Consequences — "byte-exact" is a property of the *shell* boundary, not of
the pipeline.

**7. The guard shipped by `27a980d` and the test that pins it are
replaced, not kept.** `set -o noglob` exists to make an unquoted splice
survivable. Once there is no splice, the guard protects nothing, and
`tests/plugin-shape/test-runbook-shell-portability.mjs` — which asserts
that at least one `set -o noglob` guard survives — would **block this
change**. It is replaced with assertions for the new boundary: no
unquoted argument variable inside any bash block, every capture site
paired with its removal, and byte-exact replay of the corpus as fixtures.

## Consequences

**Positive.** The dominant failure class disappears at the boundary rather
than being mitigated: 105 of 311 exact becomes 311 of 311 for the shell
segment, and the silent-truncation mode — the one that corrupts a decision
without reporting it — is structurally impossible once the text is never
a command line. The change is smaller than first scoped, because the
parsers already take `--` plus an intact body. The capture step is
executable code the runbook carries, so it is verifiable end to end by
running it; that is what produced the 311-of-311 figure.

**Negative — and this is the honest headline.** **The pipeline is not
byte-exact, and this ADR does not make it so.** The host delivers the
argument text only inside the runbook markdown, so the model transcribes
it into the tool call in every design available today. Measured, by the
actual actor, on eight hostile cases read from a rendered display:

| result | cases |
|---|---|
| exact | trailing space, double space, tab, plain |
| **lost** | NBSP → plain space, zero-width → dropped, CRLF → LF, combining `é` → precomposed |

Four of eight, and the case labels named what to look for, so that is an
**upper bound**. No candidate transport removes this; a file-writing tool
relocates it rather than closing it. What the decision claims is
therefore narrow and true: the *shell* stops damaging the text.

Whether the ceiling bites in practice is **not settled by this repository's
corpus, and the reason is circular**: none of the 311 topics contains NBSP,
zero-width, CR, combining marks, other space characters, trailing space,
double space or tab — but `original_request` is itself written through a
model transcription, so a zero there cannot evidence what transcription
already removed. All eight detectors were validated with planted positives
and clean negatives; an earlier NBSP detector missed its own planted case
and is corrected. What the zero does establish is that the text actually
reaching these CLIs is plain, single-spaced prose — precisely the text the
shell damages at two-thirds.

Other costs: sixteen runbooks change across four packages, so per-package
commits under ADR-0016 and four releases; the runtime assets only take
effect once released and installed; a temporary file acquires a lifecycle
(created, read, removed) and its removal must survive an early exit.

**Neutral.** The persona CLIs keep their interfaces. `--args-file` follows
the precedent this repository already set with `--prompt-file` for peer
dispatch: prose reaches a process as a file, never as argv.

## Alternatives Considered

**One double-quoted argument.** Rejected on measurement: 271 of 311 exact,
36 corrupt. Double quotes still permit `$` and backtick expansion, so
`$(id -un)` executes; an embedded double quote ends the string.

**One single-quoted argument.** Rejected on measurement: 198 of 311 exact,
70 crashes. Any apostrophe terminates the quoting, and apostrophes appear
in 32 of the corpus's failures.

**Per-token quoting by the model.** Scored 311 of 311 in the harness and
is still rejected, on two independent grounds. The harness quoted
*mechanically*; the proposal is for the *model* to quote, and the 4-of-8
transcription result above is what that substitution costs. Separately,
splitting on whitespace and rejoining loses whitespace **structurally** —
newline, tab, leading and trailing spaces and runs of spaces all collapse,
failing five of eight edge cases. The existing parser joins body tokens
with single spaces, so the loss is not recoverable downstream.

**A file-writing tool instead of a heredoc** — the cross-host review's
preference, on the ground that it removes the shell from the capture path
entirely. Not adopted, and the reason is the one that decides this ADR:
the heredoc path is **machine-verifiable** and the tool path is not. The
heredoc's correctness was established by running it over 311 topics and
eight hostile edge cases; the tool path cannot be pinned by any test
without a model in the loop, and this repository has repeatedly paid for
leaving correctness to model discretion — the completion footer became
code-emitted for that reason (ADR-0039), and the `set -f` guard survived
review for the same one. The review's own stated condition for the
heredoc is satisfied by Decision 2. Its remaining advantage — no delimiter
residual — is real but bounded and was measured closed.

**Status quo plus a character blocklist.** Rejected on measurement: the
failures are combinatorial. Every individually harmless character passes
in isolation and fails in combination, so no list of characters
characterizes the damage.

**Keep `set -o noglob` alongside the new transport.** Rejected as
misleading rather than harmful. A guard that protects nothing invites a
future reader to conclude the splice is still there and still guarded.

## Implementation notes

Not part of the decision, but required when it lands:

- Acceptance asserts **byte-exact body preservation and absence of side
  effects**, never exit status. The 311 topics are replayed as fixtures.
  A probe that splices untrusted text into a shell line runs with its
  working directory **outside the repository** — the 16 stray files this
  investigation created are the reason that is written down.
- `tests/plugin-shape/test-runbook-shell-portability.mjs` is replaced per
  Decision 7 in the same change that removes the last splice, not before.
- Per-package commits under ADR-0016: `plugins/runtime` (11 sites),
  `plugins/designer` (2), `plugins/engineer` (2), `plugins/founder` (1).
  The Codex skill mirrors carry the same instructions and change with
  their packages.
- The temporary file is removed on every exit path, including the parser
  error path that already exits early today.
