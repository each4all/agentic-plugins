> **Status: UNVERIFIED — 2026-08-20.** This document assembles measured inputs
> for the ADR-0053 §Decision 5 human review. It has **not** been independently
> re-verified, and it is not `review_provenance`.
>
> The next subtask must **re-execute the controls, not read the conclusions**.
> Every negative claim below names the control that would have produced a
> positive; the previous review (R2) had seven claims disproved on exactly that
> basis, three of them materially, and one of its own controls was
> methodologically sound while aimed at the wrong object. Treat each number here
> as a claim about a command, and re-run the command.

# Grant review brief — claude 2.1.236 and 2.1.237 / codex 0.148.0

Prepared for the ADR-0053 §Decision 5 human review. Runtime cannot produce this
judgement; this document only assembles measured inputs for it.

## 1. Scope

- **Host tuples under review**: claude `2.1.236` / codex `0.148.0`, **and**
  claude `2.1.237` / codex `0.148.0`. Both were really installed on this
  machine — `2.1.236` at 05:05 and `2.1.237` at 10:34 local on 2026-08-20 —
  and both deltas are reviewed here, so a cohort may name either or both.
  Neither is a range: §Decision 7 requires explicit complete tuples.
- **Against installed**: runtime `0.91.2`; packages attention 0.9.0,
  companions (plugin) 0.4.0, designer 0.3.4, engineer 0.21.5, founder 0.4.4,
  image 0.2.0, orchestrator 0.13.3. The top-level `companions` **release**
  package at 0.3.0 is a different thing from the plugin the grant namespace
  binds; R2 recorded that confusion as a correction and it is not repeated here.
- **Delta since the last *reviewed* pair** (claude `2.1.235` / codex `0.147.0`,
  the stronger of R2's two granted tuples — **not** the packaged exactness
  header, which still reads `2.1.233` / `0.147.0` and is a different fact):
  **two Claude versions and one Codex version.**
- **This is the first grant review in which the Codex host actually moves.**
  R2 reviewed Codex as `exact` at `0.147.0` in both its tuples. The asymmetry is
  the defining feature of this review: the Claude delta is 35 changelog items
  across two releases, and the Codex delta is 393 release-body bullets in one.

### 1.1 Input corpus — pinned, because ST2 must verify the same bytes

| Input | Identity | Fetched (UTC) | sha256 of the fetched body |
| --- | --- | --- | --- |
| Claude Code CHANGELOG.md | `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` | 2026-08-20T07:23:55Z | `80130ea60ce384819801f57804285bf498ce474554f9a444405c530278145b39` |
| — entry `## 2.1.236` | extracted by the file's own `## <version>` delimiter | same | `590236a0ae7f1e4f0b3e73e862dd3c40da4b79db6b11d54bdd3f4ed4090e3623` |
| — entry `## 2.1.237` | same | same | `871c0e086de1b6b5d2ba71c1090db6e509bf39d2892c02b823cefd2b4d293b75` |
| Codex CLI release notes | tag `rust-v0.148.0`, `gh release view rust-v0.148.0 --repo openai/codex`, published 2026-08-18T22:26:03Z, <https://github.com/openai/codex/releases/tag/rust-v0.148.0> | 2026-08-20T07:31:00Z | `02a053b241b90dba7012a6a29a876d4dc48fad6cf6a5cc49a0af3f12e18bb7df` |

The Codex body was taken as release-body **text**, not the rendered HTML a
`runtime:compat` artifact would carry, because the HTML is an order of magnitude
larger and carries no additional items.

**Measured item counts, and one correction to the dispatch that produced this
brief.** The dispatching plan stated "2.1.236 (30 items)". Counted by the
delimiter the file itself uses: `2.1.236` carries **33** bullets, `2.1.237`
carries **2**, and codex `0.148.0` carries **393**. The `2.1.237` and codex
figures match the plan; the `2.1.236` figure does not, and 33 is what the corpus
says. A second, independent count run on the peer host reported the same three
numbers, and additionally decomposed the Codex 393 into 13 curated bullets plus
380 unique `- #NNNN` appendix rows — the 13 summarise PRs that also appear in the
appendix, so surface screening below uses the 380 unique rows rather than
double-counting.

### 1.2 Why the pair reads `unassured` today

Not because of drift, and not because anything was found broken. The one
existing grant names cohort `{2.1.234, 0.147.0}` and `{2.1.235, 0.147.0}`; the
installed pair is `{2.1.237, 0.148.0}`, which is a member of neither. That is
**cohort miss** — the exact consequence ADR-0053 §Neutral states in advance,
reproduced on this machine within a day of the grant shipping. It is the
mechanism working, not a defect.

Note the review is nominally of the whole PAIR, not just the delta. What makes
it tractable is that R2 documented the Claude side surface-by-surface at
`2.1.235`; the incremental judgement is the two Claude deltas, the whole Codex
delta, and the carried residuals in §4 — plus, per §3.5, one pre-existing defect
that only a whole-pair review would have been obliged to find.

## 2. Delta vs the ADR-0053 consumed-surface list — measured

ADR-0053's Decision section names six consumed surfaces (hooks, plugin manifest
schema, permission model, tool availability, subagent behavior, sandboxing). R2's
verification added four more (marketplace registration, authentication / error
semantics, background-task notification delivery, pre-approval file access). All
ten are carried here.

**The extractor was validated before it was trusted.** R2's §2 counts for
`2.1.234` and its §8.1 counts for `2.1.235` were independently re-derived and
published as verified. This brief's extractor reproduces **all sixteen** of those
published figures exactly — `2.1.234` hooks 0 / manifest 0 / marketplace 1 /
permission 9 / sandbox 1 / subagent 2 / tool-availability 1, and `2.1.235`'s nine
values including its five zeros. The hooks control holds too: the same extractor
finds 1 hook line in `2.1.204`. An extractor that reproduces a corpus somebody
else verified is the strongest cheap control available here.

### 2.1 Claude — lexical counts, on R2's method

| Surface | 2.1.236 | 2.1.237 | Reaches this framework? |
| --- | ---: | ---: | --- |
| Hooks | **1** | 0 | **No** — item 17 is a *self-hosted-runner* post-session hook, not the plugin hook system. Control: `post[-_ ]?session` across `plugins/**/hooks/*.json` and the Claude hook adapters returns zero against a registered-event control that returns 28. |
| Plugin manifest | 0 | 0 | No. |
| Marketplace | 0 | 0 | No. |
| Permission model | 1 | 0 | **No** — item 33 is a VS Code screen-reader feature that *announces* permission requests. The permission-model items in this entry do not carry the word; see §2.2. |
| Sandbox | **1** | 0 | Item 3, and it is real — see §3.1. |
| Subagent / teammate | 0 | 0 | Lexically silent, and the silence is not evidence — see §2.2. |
| Tool availability | 0 | 0 | Same. |
| Authentication / error semantics | 0 | 0 | Same. |
| Background-task delivery | **5** | 0 | **No** — all five (items 4, 15, 20, 25, 32) are clipboard/housekeeping, spinner tips, a session counter, `/goal` check-in, and footer alignment. **None** is the between-turn notification channel R2's V2 identified; that was `2.1.234` entry 49 and it does not move here. |
| Pre-approval file access | 0 | 0 | No. |

**The lexical matrix is wrong in both directions here, and that is the finding.**
Four of its eight non-zero hits are false positives for the consumed surface, and
— more dangerously — five of this review's eight substantive judgement targets
land in rows the matrix reports as **zero**. R2 already warned that its counts
were lexical; this entry is where that warning becomes load-bearing rather than
a footnote. A reviewer who reads §2.1 alone would conclude that `2.1.236` touches
one sandbox line and nothing else.

### 2.2 Claude — semantic disposition of every item the lexical pass misses

Built by sweeping all 33 items rather than by regex. A second, independent
classification produced on the peer host assigned permission 5 (items 3, 11, 21,
22, 23), tool availability 2 (items 16, 28), auth/error 1 (item 27), and hooks 1
(item 17) — the same items, from a corpus it counted itself, and its item
indices match this brief's exactly.

| Item | Line | Surface it actually lands on | Disposition |
| ---: | --- | --- | --- |
| 1 | `ANTHROPIC_DEFAULT_MODEL` added | Model resolution — **a surface ADR-0053's list does not name** | Does not reach. Measured: `ANTHROPIC_` matches **zero** times across `plugins/`, `companions/`, `scripts/`. Control recalibrated after a first attempt used `ANTHROPIC_MODEL` as its control and got zero — a control that returns zero proves nothing. `CLAUDE_CONFIG_DIR` (4), `AGENTIC_COMPANIONS_ROOT` (32) and `CODEX_HOME` (61) confirm the search works. |
| 2 | `notify_when_idle` on cross-session `SendMessage` | Subagent / teammate | Does not reach. `notify_when_idle` 0, `ListAgents` 0, `SendMessage` 2 — both in `plugins/runtime/docs/host-parity-baseline.md` prose. It is a cross-session idle notice, **not** the background-job completion channel four packages wait on. |
| 3 | macOS wildcard read-deny precedence | Sandbox | Reaches — §3.1. |
| 16 | Skills hot-reload after a deleted working directory | Tool availability | Safe-direction fix; the framework does not delete its working directory mid-session. |
| 21 | auto mode sets aside `Monitor` allow rules | Permission model | Does not reach. `Monitor` as a whole word matches **zero** times across `plugins/`, `companions/`, `scripts/`, against known-positive controls `peer-runner.mjs` (151) and `subagent_type` (3). |
| 22 | auto-mode classifier defaults on Bedrock / Vertex / Foundry | Permission model | Not exercised on this machine. |
| 23 | auto mode's git status check no longer fooled by `status.showUntrackedFiles=no` | Permission model | Does not change anything the framework consumes — **but it names a defect the framework has in its own code.** §3.5. |
| 27 | SIGTERM in print/SDK mode records no interrupted turn or synthetic tool denials; still exits 143 | Authentication / error semantics — the companion contract | Reaches the companion's path and was probed directly — §3.2. |
| 28 | slash-command typo no longer runs the closest fuzzy match | Tool availability / plugin command surface | Reaches the 57 command runbooks, in the safe direction — §3.3. |

`2.1.237`'s two items — LLM-gateway/custom-base-URL prompt caching, and a new
"Concise" output style — land on no consumed surface. Control: `outputStyle`,
`output style`, `ANTHROPIC_BASE_URL` and `gateway` each match zero times across
`plugins/`, `companions/`, `scripts/`, under the same validated search that finds
`CLAUDE_PLUGIN_ROOT` 427 times.

### 2.3 Codex 0.148.0 — the surface that R2 never had to judge

The 13 curated bullets carry three items on consumed surfaces directly:

- **Hooks: "Hooks can now run commands asynchronously and invoke MCP tools"**
  (PRs [#37533](https://github.com/openai/codex/pull/37533),
  [#38705](https://github.com/openai/codex/pull/38705)). Additive. Measured
  unadopted: the four packages that declare Codex hooks (designer, engineer,
  founder, orchestrator) carry handler leaves of exactly `["command","type"]`.
- **Permission model: resumed sessions restore their persisted working directory
  and approval policy** ([#37198](https://github.com/openai/codex/pull/37198),
  [#37368](https://github.com/openai/codex/pull/37368),
  [#38605](https://github.com/openai/codex/pull/38605)). The companion invokes
  `codex exec … --ephemeral` and does not resume sessions.
- **Sandbox: restrictions fail closed for denied or unreadable paths across Linux
  and Windows** ([#37875](https://github.com/openai/codex/pull/37875),
  [#38026](https://github.com/openai/codex/pull/38026),
  [#38416](https://github.com/openai/codex/pull/38416),
  [#38660](https://github.com/openai/codex/pull/38660)). Named platforms exclude
  this machine (`uname -s` → `Darwin`); security-positive in any case.
- **Authentication: Amazon Bedrock Runtime as a built-in provider**
  ([#38470](https://github.com/openai/codex/pull/38470)) — a new credential and
  error family reachable through the same `codex exec` path the companion uses,
  and unprobed. §4.14.

**The two findings that matter are in the 380-row appendix, not the curated
section**, and neither was on the dispatching plan's candidate list. Both were
surfaced by the peer host and then verified locally before being written here.

- **The plugin-skill loader was rewritten.** 35 appendix rows mention skills;
  seven of them *remove or unify* a loader —
  [#37444](https://github.com/openai/codex/pull/37444),
  [#37452](https://github.com/openai/codex/pull/37452),
  [#37457](https://github.com/openai/codex/pull/37457) ("Remove the legacy core
  skill loader"), [#37461](https://github.com/openai/codex/pull/37461),
  [#37505](https://github.com/openai/codex/pull/37505) ("Remove the
  codex-core-skills crate"),
  [#37832](https://github.com/openai/codex/pull/37832),
  [#38635](https://github.com/openai/codex/pull/38635) — with
  [#37267](https://github.com/openai/codex/pull/37267) and
  [#37440](https://github.com/openai/codex/pull/37440) carrying plugin roots
  through the new host skill service. **All eight** of this repository's
  `.codex-plugin/plugin.json` manifests declare `"skills": "./skills/"`, so every
  package's Codex surface is delivered by the path that was replaced. §3.4.
- **`image` is no longer safely unbindable.**
  [#37788](https://github.com/openai/codex/pull/37788) — "Use native transparency
  in the imagegen skill" — moves the very capability `plugins/image` encodes a
  refusal for. §3.6.

Presence of all ten cited appendix rows was confirmed verbatim in the pinned
body, against a control: two PR numbers absent from this release return zero rows.

Cohorts screened and dispositioned as **not observable by this framework**: gRPC
code-mode and app-server transports, Guardian risk-scoring internals, plugin
telemetry, TUI rendering/export/history, and Codex's own repository-local skills.
The eighth dispatching candidate belongs here: the standing
`codex-notify-payload-variants` watch fired, but its evidence is
[#37906](https://github.com/openai/codex/pull/37906),
[#38170](https://github.com/openai/codex/pull/38170) and
[#38645](https://github.com/openai/codex/pull/38645), which are **gRPC code-mode
notifications** — a different concept from the external-program `notify=` setting
this framework consumes. `plugins/runtime/receivers/codex-notify-shuttle.mjs`
pins `agent-turn-complete` as the only payload variant, and nothing in this
release moves it. *The existence of an adjacent concept is not the existence of
the concept*; the watch should stay open rather than be closed on this evidence.

## 3. What the reviewer actually has to judge

**3.1 — macOS wildcard read-deny rules now take precedence inside allowed read
regions, cover matched directories' contents, and survive renaming.** Strictly a
tightening. Judgement: it can newly deny a read that previously succeeded. The
framework reads `~/.claude/**` and `~/.codex/**` under the operator's own
settings; whether any deny rule on this machine now shadows those is an operator
question, not a contract question.

**3.2 — SIGTERM in print/SDK mode no longer records an interrupted turn or
synthetic tool denials.** `companions/claude-companion.mjs` runs `claude -p
--output-format text --no-session-persistence` with the prompt on stdin, so this
is the one `2.1.236` item that touches the companion contract directly.

**Probed rather than argued.** Two variants were run against the installed
`2.1.237` binary through the installed companion:

| Variant | What was signalled | Envelope observed |
| --- | --- | --- |
| A | SIGTERM to the `claude` child only | `status=peer_error`, `exit_code=1`, `kind=peer_run_error`, `message="peer exited with code 143"`, **`stdout: ""`**, `detail: null` |
| B | SIGTERM to the companion itself | companion exits **143**, stdout empty, stderr empty — **no envelope at all** |

Positive control: the same companion, allowed to finish, returns `status=success`,
`exit_code=0`, `stdout: "ACK\n"`. So variant A's empty `stdout` is caused by the
signal, not by a broken probe.

**Conclusion: the change is not observable through this framework.** `claude -p`
emits nothing until the turn completes, so there is no partial output for the
removed records to have appeared in — on either path. And the framework's own
cancellation path cannot reach variant A alone: `peer-runner.mjs`'s `sendSignal`
targets the process **group** before the pid, so a `runtime`/`engineer` cancel
delivers SIGTERM to companion and child together, which is variant B — no
envelope, by the companion's own pre-existing design. Judgement: accept as a
safe-direction change. Recorded in detail because "the companion is
non-interactive" was R2's most-corrected argument, and this is the shape of
evidence that argument should have had.

**3.3 — A slash-command typo now reports instead of running the closest fuzzy
match; prefixes and aliases still run.** 57 command runbooks live under
`plugins/*/commands/*.md`, and `plugins/runtime/scripts/footer.mjs` plus
`lib/entry-brief-arbiter.mjs` **emit** command strings into the completion footer
and entry brief through `localizePluginCommands`. Under the old behaviour a
mis-localised or renamed command would have silently run the nearest match;
under the new one it reports. Judgement: this is a **safety improvement for this
framework specifically**, because it converts a silent wrong-command execution
into a visible error. Accept, or probe one footer-emitted command per host first.

**3.4 — (NEW) Codex rewrote the path by which plugin skills reach a turn.** Seven
appendix rows remove or unify a loader, and all eight `.codex-plugin` manifests
declare a skills root. Nothing in the release notes claims a behavioural change
for third-party plugin skills, and no defect was observed — but **no live
per-package Codex skill invocation was performed under `0.148.0` in this
review**, so the surface is unverified rather than verified-good. Judgement: this
is the row most likely to deserve a probe before granting. It is also the R3
analogue of R2's V2: a surface the framework *depends on* without ever parsing
anything from it, which is precisely the class a lexical sweep cannot see.

**3.5 — (NEW) `2.1.236` item 23 names a defect this framework has in its own
code.** Claude Code fixed its auto-mode git-status check being fooled by a
repository's `status.showUntrackedFiles=no` into reporting a clean tree. This
framework's workflow drift classification computes
`git status --porcelain=v1 -z | shasum -a 256` and has the same weakness,
unfixed. Measured in a throwaway repository:

```
default (setting unset), one untracked file  -> "?? untracked.txt"
                                                digest 803a04aa…0648
status.showUntrackedFiles=no, same tree      -> (empty)
                                                digest e3b0c442…b855
setting unset, untracked file removed        -> (empty)
                                                digest e3b0c442…b855
```

The second and third digests are identical, and that value is the sha256 of the
empty string — so **a tree with untracked files is indistinguishable from a
genuinely clean tree** under that setting. Blast radius: 5 packages
(`designer`, `engineer`, `founder`, `orchestrator`, `runtime`) across 55 sites,
and the ambiguous digest already appears 269 times in this repository's live
workflow state, because "clean" is its common value.

**Attribution, stated precisely.** This is **pre-existing and not created by this
delta** — `git status --porcelain` has always honoured the setting, and no
`2.1.236` or `2.1.237` change alters it. As with R2's V1, the delta widens
attention rather than the surface. It is a **residual on the pair under review**,
not a blocking delta defect, and it is in scope because the review is of the
whole pair. Severity is bounded by the fact that the setting is not set in this
repository and is uncommon; the cost if it were set is that
`/engineer:resume`-class drift reports would read `clean` while work sat
uncommitted.

**3.6 — (NEW) `image` moved from deliberately-unbound to consumed.** R2 excluded
`image` from `grant.packages` on the stated ground that it dispatches its
companion synchronously and does not consume the background-notification channel.
That reasoning is still true and is no longer sufficient: codex `0.148.0`
[#37788](https://github.com/openai/codex/pull/37788) adds native transparency to
the imagegen skill, and `plugins/image/scripts/brief-validate.mjs` encodes the
opposite as a hard rule — `BACKGROUNDS = ['opaque', 'auto']` with the comment
`gpt-image-2: no transparent`, plus a `TRANSPARENT_BG_RE` that rejects
transparent-background requests anywhere in the brief text. Judgement: this is
**capability lag, not a regression** — the existing opaque path is untouched —
but `image` now has a direct contract contact with the reviewed Codex version,
so leaving it unbound would omit reviewed code from the grant. Bind it and
record the mismatch as a residual, or fix the validator before granting.

**3.7 — Codex hooks gained async and MCP handlers.** Additive; the four
hook-declaring packages use `command` handlers only. Judgement: accept as
unadopted. Note separately that
[#38703](https://github.com/openai/codex/pull/38703) refreshes hook runtimes
after plugin changes, which touches the `/hooks` review-and-trust ritual this
repository depends on after any hook-bearing upgrade.

## 4. Residuals the grant would carry

`grant.residuals` is required by the schema — ADR-0053 §Decision 6 notes that
without residuals assurance is strictly harder to satisfy than exactness. Shape
(`runtime-host-assurance-1.0` `$defs.residual`): `surface`, `consumption`
(`consumed` | `unadopted`), `disposition` (`accepted-with-risk` |
`probe-pending` | `not-applicable`); a `consumed` residual must name a
`consuming_package` that `grant.packages` binds.

**All eleven residuals on the existing grant carry unchanged. None is closed by
these deltas.** The Claude releases do not restore the Desktop/VS Code
`Notification` payload, do not touch backgrounded-native-subagent result
collection, do not add a non-slash plugin-update path, do not change the
transcript scanner's `CLAUDE_CONFIG_DIR` blindness, do not move the
background-task delivery format, and do not alter the trust boundary. The
authentication residual was re-checked against the installed `2.1.237` and still
holds.

Added by this review:

12. **(NEW, §3.5) The workflow drift digest cannot distinguish a clean tree from
    one hiding untracked files under `status.showUntrackedFiles=no`.** consumed /
    `accepted-with-risk` (the condition is observed, so `probe-pending` would
    misstate it) / the reviewer picks among `engineer` / `designer` / `founder` /
    `orchestrator` / `runtime`, or records one row per package as R2 did for the
    background-notification residual.
13. **(NEW, §3.4) Codex plugin-skill loader replacement.** consumed /
    `probe-pending` / one row per package whose skills were not invoked under
    `0.148.0`.

    > **Correction to a proposal this review received.** The cross-host reader
    > proposed eight such rows, one per package, *including `attention`*.
    > Measured: `plugins/attention/skills/` contains a `README.md` and nothing
    > else, against a control (`plugins/engineer/skills/` → 11 entries). attention
    > is a hook-only plugin by design (ADR-0040 §3), so a residual asserting that
    > its skills stay invokable is **vacuous** — there are none. Seven rows, not
    > eight. The manifest's `"skills": "./skills/"` declaration pointing at an
    > empty root is worth a separate look, but it is not this residual.
14. **(NEW, §2.3) Amazon Bedrock as a built-in Codex provider** introduces an
    unprobed credential/error family on the `codex exec` path the companion uses.
    consumed / `probe-pending` / `companions`.
15. **(NEW, §3.6) `image` rejects transparent-background requests that codex
    `0.148.0`'s imagegen skill now supports.** consumed / `accepted-with-risk` /
    `image` — which requires `image` to be added to `grant.packages`.
16. **(NEW, §3.7) Codex hook-runtime refresh after plugin changes** interacts
    with the manual `/hooks` review-and-trust step. consumed / `probe-pending` /
    one of the four hook-declaring packages.

The residual count matters mechanically: the schema caps residuals, and eleven
carried plus a per-package expansion of rows 12–13 approaches that cap. A
reviewer who wants fewer rows should run the probes rather than compress the
surfaces into one row each.

## 5. What the grant needs (schema `runtime-host-assurance-1.0`)

Required: `id`, `state`, `reviewed_at`, `review_provenance`, `cohort`,
`packages`, `residuals`.

- `id` — a **new, immutable** id. Never edit the released first grant; records
  are append-only per ADR-0054 §Decision 8.
- `cohort` — explicit complete tuples. Minimum `[{claude: "2.1.237", codex:
  "0.148.0"}]`; `{claude: "2.1.236", codex: "0.148.0"}` may be named alongside
  it since both were installed here and both deltas are reviewed above.
- `packages` — **eight, not seven.** R2's seven plus `image`, per §3.6. Every
  named package must be at exactly the installed version, and `runtime` must be
  the version of the release that *carries* the grant — not `0.91.2`. Hardcoding
  today's value is how a grant ships dead.
- `review_provenance` — the durable identity of the owner's decision. **This
  document is verification input, not owner provenance**; runtime only checks the
  reference is non-empty, so the owner decision needs its own artifact.
- `residuals` — §4.
- `predicate` — **omit it.** Every permitted key is unobservable and yields
  `unassured`; empty `predicate: {}` is the only non-blocking form and scopes
  nothing.

**Two implementation consequences that are not schema fields**, both verified
locally: `tests/runtime/test-host-assurance-record.mjs` asserts
`grants.length === 1` with the message *"R2 ships one grant, alone"*, and
`tests/scripts/test-assurance-monotonicity.mjs` asserts `target_grants === 1`.
Both fail the moment a second grant lands, by design — the first pins by identity
rather than by count, so the transition is to *add* a second identity pin, not to
relax the assertion. And because the baseline is a protected packaged asset, the
grant does not take effect until a `plugin-runtime` release ships it and both
hosts are updated; `main` is expected to be red in the interval.

## 6. Known consequence of granting

The cohort is a finite tuple set, so the next version of **either** host falls
outside it and reads `unassured` again. This review is itself the evidence: the
first grant shipped and the machine had already moved past its cohort. Locally
observed movement is asymmetric — Claude sits on a version for a median of about
2 days, Codex for about 10 — which is why the Codex side stayed `exact` through
R2 and produced a 393-item delta the moment it moved.

That asymmetry is the practical lever. A Codex-side plateau of roughly ten days
is long enough that the expensive half of this review (§2.3) has a usable shelf
life, while the Claude side will move again within days. If the reviewer wants
fewer laps, the available move is naming **several already-reviewed tuples** in
one cohort — not a range, and not a future version.

**Re-probe both host versions immediately before ratification, and again before
recording the post-release proof.** R2 had to retarget mid-review when Claude
moved; this review was written while `2.1.237` had been installed for under six
hours.

## 7. Method note

This brief was built by the discipline R2's §7 arrived at, plus one correction it
recommended.

Negative claims name a control, and the control was executed. That caught a real
error here: the first attempt to dispose of `ANTHROPIC_DEFAULT_MODEL` used
`ANTHROPIC_MODEL` as its control and got **zero for both** — a control that
returns zero establishes nothing, and the disposition was only sound after
re-running against tokens known to be present. The same recalibration was needed
for the `Monitor` row.

The extractor itself was validated against a corpus somebody else had already
verified, before any new number was trusted.

R2's sharper lesson — that a control can be methodologically sound and still
measure the wrong object, and that the defence is a second reader who does not
share the first one's frame — was acted on rather than restated. A cross-host
reader was dispatched with the topic, the scope, the pinned corpus and the
surface list, but deliberately **without** this review's candidate list, so that
its attention was not pre-framed. It returned the two findings that the
dispatching plan's eight candidates did not contain (§3.4, §3.6), both of which
were then verified locally before being written down. It also returned a residual
ledger whose per-package expansion was measured to be vacuous in one row (§4.13
correction) — so the second reader is a source of claims to verify, not of
conclusions to adopt.

What this brief did **not** do, stated so the gap is not mistaken for coverage:
no live Codex skill invocation under `0.148.0`, no `/hooks` re-review after the
Codex upgrade, no long-output background-completion probe, no Bedrock credential
failure, and no fresh `runtime:doctor` proof against the reviewed pair. Those are
evidence gaps, not observed defects, and §4 records them as such.
