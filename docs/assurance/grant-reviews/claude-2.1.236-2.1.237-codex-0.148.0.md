> **Status: VERIFIED — 2026-08-21.** The control behind every claim in §1–§7 was
> re-executed independently of this document's conclusions, by a local pass and
> by a cross-host reader; the raw outputs are in **§8**. This remains
> **verification input, not `review_provenance`** — the owner's decision still
> needs its own artifact (§5).
>
> **Three results a reader must not skip.** (1) Four of §2.2's dispositions
> measure **source literals** where the consuming mechanism is **runtime
> inheritance** — the companion spawns its child with no `env` restriction at
> all — so four surfaces the residual ledger omits are in fact consumed by the
> reviewed pair (§8.4). (2) The Claude host moved to `2.1.238` nineteen hours
> after this brief was written, so the cohort it serves no longer contains the
> installed pair (§8.8). (3) The Codex **hooks** surface is dispositioned from
> three of the ten release rows that touch it (§8.6.1).
>
> Claims were **disproved** in sixteen places and are marked in situ rather than
> deleted, as R2 did, because the preserved error is what makes the next lap's
> method auditable. Five of the sixteen move a judgement: §8.4's four consumed
> surfaces, and §4.13's correction, which stops one package short of its own
> reasoning.
> Everything else re-measured — all four corpus pins including the one first
> recorded as unverifiable, all twenty matrix cells, every zero-result whose
> object really is this repository, all twenty-four cited Codex PR rows, both
> test assertions and the packaged grant — held exactly.

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

> **CORRECTION (§8.2), and the denominator this sentence does not give.** The
> sixteen do reproduce, 7/7 and 9/9. But `2.1.235`'s nine values contain **six**
> zeros, not five — a miscount inherited verbatim from R2's prose, whose §8.1
> table has six bolded zero rows. And against R2's *full* published set the same
> extractor reproduces **17 of 19**: `2.1.234`'s authentication 1 measures 4
> under `/auth/i`, and its background 1 measures 3 under `/background/i`. Those
> two rows, plus pre-approval, are exactly the three R2 added *by verification*
> and called "the classification those lines needed" — never lexical. So the
> validated sixteen are the sixteen a regex can produce, and the calibration is
> silent about the rows where a lexical extractor is weakest. The reproduction
> also depends on a token this brief never states: the "Tool availability" row
> is counted with the narrow `allowed-tools` that R2's row label names, and a
> reader who assumes `/tool/i` measures 5 for `2.1.234` and concludes the
> control failed.

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
~~Four of its eight non-zero hits are false positives for the consumed surface,
and — more dangerously — five of this review's eight substantive judgement
targets land in rows the matrix reports as **zero**.~~

> **CORRECTION (§8.3).** **Seven** of the eight non-zero hits are false
> positives, not four: items 17 (hooks), 33 (permission) and 4, 15, 20, 25, 32
> (background). Exactly one — item 3, sandbox — is substantive, so the measured
> false-positive rate is 87.5%, not 50%. Both readers measured this
> independently. The second figure does not reproduce under any mapping:
> **four** targets land in strictly-zero rows, two land in non-zero rows whose
> hit is a different item, and two have no applicable Claude row at all.

Seven of its eight non-zero hits are false positives for the consumed surface,
and — more dangerously — four of this review's eight substantive judgement
targets land in rows the matrix reports as **zero**. R2 already warned that its counts
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

> **CORRECTION (§8.4) — this table's four zero-results are correct counts and
> wrong dispositions.** `companions/claude-companion.mjs` spawns the peer with
> options `{ cwd, stdio }` and **no `env` key**, so Node's default applies and
> the child inherits the parent environment whole. A token this repository never
> writes therefore still reaches the child:
>
> - **Item 1, `ANTHROPIC_DEFAULT_MODEL`.** `buildClaudeArgs` emits `--model`
>   only when a model is passed, and the runtime posture is
>   `model_effort_fallback=host-native`, so an unpinned companion call lets the
>   child resolve its own default — which is exactly what the new variable sets,
>   while the envelope still reports the host-native default.
> - **`ANTHROPIC_BASE_URL` / gateway prompt caching.** Measured: a child spawned
>   through the *installed* companion received the variable from its parent.
> - **The "Concise" output style.** The companion passes neither `--safe-mode`
>   nor `--setting-sources`, so host settings apply to the child. The style is
>   unset today — unreached *by configuration*, not *structurally*.
> - **Item 21, `Monitor`.** `Monitor` is host-native, not a repository token:
>   this project's own transcripts carry **11 `Monitor` tool-use calls across 6
>   of 69 sessions**, and the host permission mode is `auto`. Setting aside its
>   allow rules changes approval behaviour in the interactive session where the
>   57 command runbooks run — the scope R2's V3 established.
>
> None is a defect and none was observed failing. But §4 builds the residual
> ledger from these dispositions, so a grant issued on it asserts review of a
> surface set that omits four consumed surfaces. Each is cheap to carry as
> `accepted-with-risk`: the first three on `companions`, the fourth on the
> runbook-bearing packages.

### 2.3 Codex 0.148.0 — the surface that R2 never had to judge

The 13 curated bullets carry three items on consumed surfaces directly:

- **Hooks: "Hooks can now run commands asynchronously and invoke MCP tools"**
  (PRs [#37533](https://github.com/openai/codex/pull/37533),
  [#38705](https://github.com/openai/codex/pull/38705)). Additive. Measured
  unadopted: the four packages that declare Codex hooks (designer, engineer,
  founder, orchestrator) carry handler leaves of exactly `["command","type"]`.

  > **GAP (§8.6.1) — this row is judged on 3 of the 10 release rows that touch
  > it.** Ten appendix rows mention hooks; this brief cites three
  > ([#37533](https://github.com/openai/codex/pull/37533),
  > [#38703](https://github.com/openai/codex/pull/38703),
  > [#38705](https://github.com/openai/codex/pull/38705)) and never screens
  > seven: [#37363](https://github.com/openai/codex/pull/37363),
  > [#37527](https://github.com/openai/codex/pull/37527),
  > [#37538](https://github.com/openai/codex/pull/37538),
  > [#37644](https://github.com/openai/codex/pull/37644),
  > [#38361](https://github.com/openai/codex/pull/38361),
  > [#38394](https://github.com/openai/codex/pull/38394),
  > [#38568](https://github.com/openai/codex/pull/38568). At least four of them
  > — timing out and killing hook process trees, generalizing handler execution,
  > reordering tool-start callbacks against pre-tool hooks, and rejecting
  > sessions whose required hooks will not load — change the execution path the
  > `command` handlers above already run on. Hooks is the first consumed surface
  > ADR-0053 names, so "additive, unadopted" is a verdict this evidence does not
  > yet support, and §7 does not list the gap. No defect was observed; none was
  > looked for. Unlike the sandbox residue, not one of the seven names a
  > platform or transport that would put it out of scope.
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
[#38645](https://github.com/openai/codex/pull/38645), ~~which are **gRPC
code-mode notifications**~~ — a different concept from the external-program
`notify=` setting this framework consumes.

> **CORRECTION (§8.6), and a stronger control than this paragraph used.** Two of
> the three are gRPC code-mode by title and by their commits' file lists;
> [#38170](https://github.com/openai/codex/pull/38170) is *"Notify running turn
> watchers only on count changes"* — an **app-server** running-turn watcher, a
> third concept. The disposition nevertheless holds, on evidence this paragraph
> did not have: the **installed 214 MB codex binary** — resolved past the 7 KB
> PATH shim — carries `agent-turn-complete` exactly once and no other `agent-*`
> notification variant, against live controls (`notify` 40, `codex` 1006). The
> consumed payload variant did not move, measured at the source rather than in
> the release notes. Keep the watch open, and fix its taxonomy: grouping by
> "gRPC code-mode" would miss app-server notification behaviour.
 `plugins/runtime/receivers/codex-notify-shuttle.mjs`
pins `agent-turn-complete` as the only payload variant, and nothing in this
release moves it. *The existence of an adjacent concept is not the existence of
the concept*; the watch should stay open rather than be closed on this evidence.

## 3. What the reviewer actually has to judge

**3.1 — macOS wildcard read-deny rules now take precedence inside allowed read
regions, cover matched directories' contents, and survive renaming.** Strictly a
tightening. Judgement: it can newly deny a read that previously succeeded. The
framework reads `~/.claude/**` and `~/.codex/**` under the operator's own
settings; ~~whether any deny rule on this machine now shadows those is an operator
question, not a contract question.~~

> **CLOSED, not deferred (§8.5).** The question was measured rather than handed
> to the owner: all four settings files — user and project, both plain and
> `.local` — declare **zero** `permissions.deny` rules. There is no deny rule
> for the new precedence to apply to, so this item cannot shadow a read on this
> machine. It stays an operator question only in the sense that adding a deny
> rule later would reopen it.

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
targets the process **group** before the pid, so ~~a `runtime`/`engineer` cancel
delivers~~ an `engineer` cancel delivers SIGTERM to companion and child together,
which is variant B — no envelope, by the companion's own pre-existing design.

> **CORRECTIONS (§8.7) — two, and neither reverses the judgement.** First, the
> variant A row is **timing-dependent**: the table reproduces when the signal
> arrives after a delay, but an immediate SIGTERM yields
> `companion_error` / exit `3` / `peer_invocation_error` — a different branch
> that downstream error handling treats differently. Second, the generalisation
> to `runtime` is wrong: **runtime has no peer-runner.** Its generic timeout
> helper `runCommand` (`plugins/runtime/scripts/doctor.mjs`) spawns without
> `detached` and calls `child.kill('SIGTERM')` — a single-PID kill, with no
> group-first guarantee. `sendSignal`'s group-then-pid ordering is exact for the
> engineer path and was re-verified.
>
> One gap this section should own: "the change is not observable" was inferred
> from the post-change binary only. No `2.1.235` counterfactual was run by
> either reader, and the live success control could not be reproduced on this
> network. The conclusion is plausible and untested.
 Judgement: accept as a
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
`gpt-image-2: no transparent`, plus a `TRANSPARENT_BG_RE` that ~~rejects
transparent-background requests anywhere in the brief text~~ rejects *some*
spellings of a transparent-background request.

> **CORRECTION (§8.6).** Probed against the real regex: `transparent background`,
> `background must be transparent`, `alpha channel` and `see-through background`
> are rejected, but **`transparent-background` — the hyphenated spelling this
> very sentence uses — passes**, as does `transparentbackground`. The
> capability-lag judgement below is unchanged and the residual still belongs;
> what does not survive is "categorically refused". A brief can request the
> capability in a spelling the validator does not catch, which makes the
> operator-facing story inconsistent in the opposite direction from the residual.
 Judgement: this is
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
    > its skills stay invokable is **vacuous** — there are none. ~~Seven rows, not
    > eight.~~ The manifest's `"skills": "./skills/"` declaration pointing at an
    > empty root is worth a separate look, but it is not this residual.
    >
    > > **CORRECTION (§8.9) — the correction above stops one package short of its
    > > own reasoning.** `plugins/companions/skills/` contains a `README.md` and
    > > nothing else too: measured `SKILL.md` counts are attention **0**,
    > > companions **0**, designer 10, engineer 10, founder 10, image 6,
    > > orchestrator 8, runtime 11. companions is a script-only library plugin
    > > (ADR-0008), so the same vacuity argument applies to it verbatim. **Six
    > > rows, not seven.** This is the shape the whole document is guarding
    > > against: a defect was found in one instance and the mirror was not
    > > checked.
14. **(NEW, §2.3) Amazon Bedrock as a built-in Codex provider** introduces an
    unprobed credential/error family on the `codex exec` path the companion uses.
    consumed / `probe-pending` / `companions`.
15. **(NEW, §3.6) `image` rejects transparent-background requests that codex
    `0.148.0`'s imagegen skill now supports.** consumed / `accepted-with-risk` /
    `image` — which requires `image` to be added to `grant.packages`.
16. **(NEW, §3.7) Codex hook-runtime refresh after plugin changes** interacts
    with the manual `/hooks` review-and-trust step. consumed / `probe-pending` /
    one of the four hook-declaring packages.

~~The residual count matters mechanically: the schema caps residuals, and eleven
carried plus a per-package expansion of rows 12–13 approaches that cap.~~ A
reviewer who wants fewer rows should run the probes rather than compress the
surfaces into one row each.

> **CORRECTION (§8.9).** With the corrected package count the worst-case
> expansion is `11 + 5 + 6 + 1 + 1 + 1 = 25` against a cap of **32** — it does
> not approach the cap, so cap pressure is not an argument for compressing rows.
> The advice that survives is the second sentence, which never needed the first.
> Note also that §8.4 adds four consumed surfaces this ledger does not carry.

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

> **THIS ALREADY HAPPENED (§8.8).** The re-probe was run one day later and the
> Claude host had moved again: `2.1.238` was installed on 2026-08-21 at 05:35
> local, **19h01m** after `2.1.237`. Because `cohortMatch` is exact tuple
> equality over both hosts — verified in `assurance-contract.mjs`, no range
> tolerance — a grant naming `{2.1.237, 0.148.0}`, with or without
> `{2.1.236, 0.148.0}`, resolves `unassured` on this machine the moment it
> ships. The median cited above is also not what this machine shows: the last
> two Claude transitions were **5h29m** and **19h01m**, both far under two days,
> while Codex has held `0.148.0` throughout. The Codex-side plateau is real; the
> Claude-side one is not, and the cohort decision has to be made against the
> shorter number. `2.1.238` was **not** reviewed here — its 39 changelog items
> are outside this brief's corpus — so naming it would grant an unreviewed
> tuple. The three options are laid out in §8.8.

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

## 8. Independent re-verification (ST2)

Re-executed on **2026-08-21** against this repository at `88ff062`, the same
upstream sources, and the installed hosts — by a local pass and, independently,
by a cross-host reader dispatched with the brief but not with the local pass's
candidate list. **Verdict** is CONFIRMED / DISPROVED / UNVERIFIABLE; a zero
result with no non-zero control is UNVERIFIABLE, never a confirmation.

**The headline is not an arithmetic slip.** Four of §2.2's dispositions share one
root: they measure **source literals** where the consuming mechanism is **runtime
inheritance**, and a repository that never writes a token still receives it. That is §8.4, it changes the residual set, and it is the same shape
as R2's V3 correction — an argument that bounds the *repository* being read as
though it bounded the *grant*. Two further items stand beside it: the Claude host
**moved again** (§8.8), and the Codex **hooks** surface is judged on three of the
ten release rows that touch it (§8.6.1).

What held: all four corpus pins, all twenty matrix cells, every zero-result whose
object really is the repository, all twenty-four cited Codex PR rows, both test
assertions, and the packaged grant's cohort, packages and residual count.

### 8.1 Input corpus (§1.1) — all four pins verify, including the one thought unverifiable

| Claim | Input | Control | Command | Raw output | Verdict |
| --- | --- | --- | --- | --- | --- |
| codex body sha256 `02a053b241b90dba7012a6a29a876d4dc48fad6cf6a5cc49a0af3f12e18bb7df` | release body text | tag and `publishedAt` compared to the pin; `jq -j` vs `jq -r` | `gh release view rust-v0.148.0 --repo openai/codex --json body,publishedAt,tagName`, then sha256 of the raw body | pin reproduced exactly; `publishedAt 2026-08-18T22:26:03Z`; 27747 bytes. **The pin is one byte sensitive**: `jq -r` appends a newline and yields a different hash | **CONFIRMED** — record the extraction as raw-body, no trailing newline |
| entry `2.1.236` sha256 `590236a0ae7f1e4f0b3e73e862dd3c40da4b79db6b11d54bdd3f4ed4090e3623` and entry `2.1.237` sha256 `871c0e086de1b6b5d2ba71c1090db6e509bf39d2892c02b823cefd2b4d293b75` | CHANGELOG entries | 21 extraction conventions tried | re-fetch, split on `^## `, hash each candidate | both reproduce, on `"\n" + body` — a leading newline before the entry body. The nine obvious conventions all miss | **CONFIRMED** |
| whole-file `CHANGELOG.md` sha256 `80130ea60ce384819801f57804285bf498ce474554f9a444405c530278145b39` | the file on `main` | byte length compared to the reconstruction | remove only the `2.1.238` block from today's file, then sha256 | `529591` bytes, hash reproduced **exactly** | **CONFIRMED** — the local pass first recorded this as unverifiable-by-design; the cross-host reader showed the changelog's append-only shape makes even a `main` pin recoverable. The pin is still *identified* by a mutable URL, which is a separate defect (§8.10) |
| item counts 33 / 2 / 393, and 393 = 13 curated + 380 unique `- #NNNN` | the three entries | unique vs total PR numbers compared | `grep -c '^- '`; regex split on `^\s*-\s+#\d+` | 33, 2, 393; curated 13, appendix 380, distinct PR numbers 380 | **CONFIRMED** |

### 8.2 The extractor's self-validation (§2) — true as written, on a denominator that excludes its weakest rows

| Claim | Input | Control | Command | Raw output | Verdict |
| --- | --- | --- | --- | --- | --- |
| "reproduces **all sixteen** of those published figures exactly" | `2.1.234` (7 figures) + `2.1.235` (9 figures) | R2's published values | ten surface regexes over each entry's bullets | **16/16 reproduce** | **CONFIRMED as stated** |
| — the same extractor against R2's *full* published set | R2 §2's ten-row table too | same | same | **17 of 19**: R2's `2.1.234` **authentication 1** measures **4** under `/auth/i`, and its **background 1** measures **3** under `/background/i` | **The gap is real and is the point.** Those two rows, plus pre-approval, are exactly the three R2 *added by verification* and described as "the classification those lines needed" — they were never lexical. So the sixteen that reproduce are the sixteen a regex can produce, and the calibration is silent about the rows where a lexical extractor is weakest |
| "…including its **five** zeros" | R2 §8.1 table | count the zero rows directly | `grep -c '\| \*\*0\*\* \|'` | `6` | **DISPROVED** — six of nine. Inherited verbatim from R2's own prose |
| hooks control: `post[-_ ]?session` → 0 against a registered-event control → 28 | claim's corpus is `plugins/**/hooks/*.json` **plus the Claude hook adapters** | a control drawn from each half separately | target over both halves; control over each | target `0` in the JSON half and `0` in the 20 adapter `.mjs` files. Control `28` comes from the **JSON half only**; an adapter-corpus control is separately non-zero (`57` event-name occurrences) | **CONFIRMED conclusion, under-covering control** — the stated control certifies traversal of half the corpus the claim covers |

### 8.3 The lexical matrix (§2.1) — every cell exact, both summary numbers wrong

| Claim | Input | Control | Command | Raw output | Verdict |
| --- | --- | --- | --- | --- | --- |
| all 20 cells (10 surfaces × two versions) | the two entries | R2's method, narrow `allowed-tools` for the tool row | ten regexes over the bullets | `2.1.236`: hooks 1, manifest 0, marketplace 0, permission 1, sandbox 1, subagent 0, tool 0, auth 0, background 5, pre-approval 0. `2.1.237`: all 0 | **CONFIRMED** — 20/20 |
| the five background hits are items 4, 15, 20, 25, 32; every cited item index | `2.1.236` | indices re-derived from bullet order | index the 33 bullets | all eleven cited indices land on the quoted text | **CONFIRMED** |
| "**Four** of its eight non-zero hits are false positives" | the matrix | enumerate all eight | — | eight hits; false positives are items 17, 33, 4, 15, 20, 25, 32 = **seven**; only item 3 (sandbox) is substantive | **DISPROVED** — 7 of 8, independently measured by both readers. The corrected figure strengthens the paragraph's own argument |
| "**five** of this review's eight substantive judgement targets land in rows the matrix reports as zero" | the eight dispatch candidates | map each to a row | — | **4** land in strictly-zero rows; 2 land in non-zero rows whose hit is a different item; 2 have no applicable Claude row | **DISPROVED** — no reading of the mapping gives five |

### 8.4 The class of error behind four dispositions — a source-literal zero is not a runtime disposition

§2.2 disposes of four `2.1.236`/`2.1.237` items by measuring that a token appears
zero times in `plugins/`, `companions/` and `scripts/`. Those counts are correct
and were reproduced here. **They do not establish what the sentences next to them
claim**, because the consuming mechanism in each case is not a literal in this
repository.

| Claim | Input | Control | Command | Raw output | Verdict |
| --- | --- | --- | --- | --- | --- |
| the companion restricts nothing about the child's environment | `claude-companion.mjs` spawn options | the option object read in full | read `runPeer`'s `spawnImpl(PEER_CLI_BIN, args, {...})` | the options are exactly `{ cwd, stdio }` — **there is no `env` key**, so Node's default applies and the child inherits the parent environment whole | **MEASURED** — this is the mechanism the four rows below run on |
| §2.2 item 1: `ANTHROPIC_DEFAULT_MODEL` "does not reach" | source literals | `CLAUDE_CONFIG_DIR` 4, `AGENTIC_COMPANIONS_ROOT` 32, `CODEX_HOME` 61, `CLAUDE_PLUGIN_ROOT` 427 | `grep -rI -- "$t" plugins companions scripts \| wc -l` | `ANTHROPIC_` **0**, controls all non-zero and exactly reproducing the brief | **DISPROVED as a disposition.** The count is right; the conclusion is not. `buildClaudeArgs` emits `--model` only when a model is passed, and the runtime posture is `model_effort_fallback=host-native`, so an unpinned companion call lets the child resolve its own default — which is precisely what the new variable sets. The envelope still reports the host-native default |
| §2.2 `2.1.237`: `ANTHROPIC_BASE_URL` and `gateway` "land on no consumed surface" | source literals | same | same | both `0` in source; the cross-host reader ran a fake child through the **installed** companion and observed it receive `ANTHROPIC_BASE_URL` from the parent environment | **DISPROVED as a disposition** — the gateway prompt-caching change reaches every unpinned companion invocation on a machine where an operator sets that variable |
| §2.2 `2.1.237`: the "Concise" output style "lands on no consumed surface" | companion argv and host settings | `CLAUDE_PLUGIN_ROOT` 427 | inspect argv; read the host `outputStyle` setting | the companion passes neither `--safe-mode` nor `--setting-sources`, so host settings apply to the child; the style is currently unset | **DISPROVED as a disposition** — the item is unreached *today by configuration*, not *structurally*. That is a residual, not a no-op |
| §2.2 item 21: `Monitor` "does not reach" | source literals **and** this repository's own session transcripts | source controls `peer-runner.mjs` 151, `subagent_type` 3; transcripts parsed for `tool_use` blocks | `grep -rIow 'Monitor' …`; JSONL parse of `~/.claude/projects/-Users-lmuffin-Workspace-agentic-plugins/*.jsonl` | source `0` with live controls; **11 `Monitor` tool-use calls across 6 of 69 transcripts**, and the host permission mode is `auto` | **DISPROVED as a disposition.** The cross-host reader reported twelve; the measured figure is **11**, and the substance is unchanged. `Monitor` is host-native: it is selected *in the interactive session where the 57 command runbooks run*, which is the scope R2's V3 established. Setting aside its allow rules under auto mode changes approval behaviour there |

**Why this matters to the owner, not just to the method.** §4 builds the residual
ledger from §2's dispositions. Four surfaces the ledger does not carry — model
default inheritance, gateway prompt caching, inherited output style, and Monitor
approval behaviour under auto mode — are consumed by the reviewed pair through
inheritance rather than through a literal. None is a defect and none was observed
failing. But a grant issued on this ledger would assert review of a surface set
that omits them. Each is cheap to add as `accepted-with-risk` on `companions`
(the first three) and on the four runbook-bearing packages (the fourth).

### 8.5 The `2.1.236` sandbox and command-surface rows (§3.1, §3.3) — one open question closed

| Claim | Input | Control | Command | Raw output | Verdict |
| --- | --- | --- | --- | --- | --- |
| §3.1 "whether any deny rule on this machine now shadows those is an operator question" | all four settings files | each file parsed, not just the first | read `permissions.deny` from user and project settings | **0 deny rules in every file** | **CLOSED, not open** — the wildcard read-deny precedence change cannot shadow a read on this machine, because no deny rule exists to take precedence. State it as measured rather than deferring it to the owner |
| §3.3 57 command runbooks; `footer.mjs` and `entry-brief-arbiter.mjs` emit commands | `plugins/*/commands/*.md`; the two emitters | per-plugin breakdown | `ls plugins/*/commands/*.md \| wc -l`; `grep -n localizePluginCommands` | `57` (designer 10, engineer 11, founder 10, image 6, orchestrator 9, runtime 11); both emitters call `localizePluginCommands` | **CONFIRMED** |

### 8.6 The Codex side (§2.3, §3.4, §3.6, §3.7)

| Claim | Input | Control | Command | Raw output | Verdict |
| --- | --- | --- | --- | --- | --- |
| the cited appendix rows are present | pinned body | four PR numbers known absent | match every `openai/codex/pull/N` in the brief against `^\s*-\s+#N` | the brief cites **24** distinct PR numbers; **24/24 present**; controls `#99999`, `#12345`, `#37999`, `#1` → 0 rows each | **CONFIRMED** — wider than the brief's own claim of ten |
| "35 appendix rows mention skills" | pinned body | — | `grep -icE '^\s*-\s+#[0-9]+ .*skill'` | `35` | **CONFIRMED** |
| "seven of them remove or unify a loader" | the seven cited rows | read each row and its upstream change | inspect the cited PRs | the central loader rewrite is supported, but `#37461` removes an **unused remote skills client** and `#38635` removes **Codex's own repository-local skills** — adjacent facilities, not the plugin loader | **DISPROVED in part** — the surface finding stands; the count is five, not seven |
| all eight `.codex-plugin` manifests declare `"skills": "./skills/"` | the eight manifests | eight plugin directories counted independently | parse each manifest | 8/8 | **CONFIRMED** |
| four packages declare Codex hooks with handler leaves exactly `["command","type"]` | the referenced `hooks.json` files | union across all four | walk every handler object | designer / engineer / founder / orchestrator; union = `[('command','type')]` | **CONFIRMED** |
| the three watch PRs "are gRPC code-mode notifications" | the three rows and their upstream commits | per-commit file lists | read each row; open each commit | `#37906` and `#38645` are gRPC code-mode; **`#38170` is an app-server running-turn watcher** | **DISPROVED in part** — 2 of 3. The disposition itself survives |
| the consumed `notify=` payload variant does not move | **the installed 214 MB codex binary**, resolved past the 7 KB PATH shim | `notify` 40, `codex` 1006, `sandbox_mode` 35 | `strings -a \| grep -cF` | `agent-turn-complete` exactly **1**; no other `agent-*` notification variant | **CONFIRMED**, on a stronger source than the release notes. The shuttle pins the same single variant (`codex-notify-shuttle.mjs:168`) |
| the companion does not resume sessions | `codex-companion.mjs`, and the live peer process for this very review | the running process list during the run | read source; `pgrep -fl` | `['exec','--skip-git-repo-check','--ephemeral']`; live: `codex exec --skip-git-repo-check --ephemeral --cd …` | **CONFIRMED** — observed, not argued |
| §3.6 `plugins/image` rejects transparent-background requests "anywhere in the brief text" | `brief-validate.mjs`, and the validator run against real inputs | positive **and negative** request forms through the same regex | probe the regex with spaced, hyphenated, closed-up and negated forms | `transparent background` REJECT; `background must be transparent` REJECT; `alpha channel` REJECT; **`transparent-background` PASSES**; **`transparentbackground` PASSES** | **DISPROVED as an absolute.** The hyphenated spelling — the one the brief's own sentence uses — is not caught. The capability-lag residual stands; "categorically refused" does not |
| §2.3 hooks: "Additive. Measured unadopted." | pinned body | classify **every** hook row by whether the brief cites it | match `^\s*-\s+#\d+ .*hook` against the brief's citation set | **10 hook rows; 3 cited, 7 not** | **GAP — see §8.6.1** |

#### 8.6.1 The hooks surface is judged on three of its ten rows

Cited: `#37533`, `#38703`, `#38705`. Never screened: `#37363` *Recognize MCP tool
hook configurations*, `#37527` *Terminate timed-out hook process trees*, `#37538`
*Expose execution mode in hook listings*, `#37644` *Generalize hook handler
execution*, `#38361` *Test hook rejection for explicitly started queue items*,
`#38394` *Reject sessions with unloadable required managed hooks*, `#38568` *Run
tool start callbacks after pre-tool hooks*.

Hooks is the **first** consumed surface ADR-0053 names, and four packages ship
Codex hooks whose handlers are all `type: command`. At least four of the seven
change the execution path those handlers already run on: a timeout-and-kill
policy over hook process trees, the shared handler-execution path, callback
ordering against pre-tool hooks, and a session-level rejection when required
hooks will not load. No defect was observed — and none was looked for. §7's list
of gaps does not mention this one, so a reader is told the surface was judged.

**The same question was then asked of every other surface**, because a gap found
in one place is worth looking for in its mirrors. The brief cites 24 of 380
appendix rows. A keyword screen gives hook 10/3, sandbox 14/2, permission 19/2,
skill 35/10, plugin 24/6, mcp 32/1, auth 23/0, notify 3/3, manifest 2/0,
marketplace 0/0 (rows / cited).

**That screen is a coverage count, not a finding count, and reading it as the
latter would be the error this document exists to catch.** Reading the rows
dissolves most of it: the sandbox residue names platforms this machine is not
(`#38061`, `#38064`, `#38080`, `#38450` Windows; `#37349`, `#38396`
Linux/Bubblewrap) or a remote executor the companion never invokes (`#37480`,
`#38043`, `#38356`); the skill residue is already carried `probe-pending` by §3.4
and §4.13; the auth column reads 0 only because `#38470`, which the brief *does*
cite, carries no auth keyword in its row text; and several of the five cohorts
§2.3 dispositions as not-observable account for the rest.

What survives is narrower and sharper. §2.3 presents itself as screening the 380
rows into *cited* plus *five named not-observable cohorts*, but those cohorts do
not account for the residue and no screening rule is stated, so for any given row
a reader cannot tell screened-and-dismissed from never-read. **Hooks is where
that ambiguity lands on a surface this repository demonstrably runs**, and unlike
the sandbox residue not one of the seven unscreened hook rows names a platform or
a transport that would put it out of scope.

### 8.7 The SIGTERM probe and the cancellation path (§3.2)

| Claim | Input | Control | Command | Raw output | Verdict |
| --- | --- | --- | --- | --- | --- |
| `buildClaudeArgs` emits `-p --output-format text --no-session-persistence`, prompt on stdin | the companion source | — | read the function | exactly that, plus optional `--model` / `--effort` | **CONFIRMED** |
| variant A: SIGTERM to the child yields `peer_error` / `exit_code 1` / empty stdout | the installed `2.1.237` through the installed companion | **immediate versus delayed delivery** | run the probe with the signal sent immediately, and again after a delay | the delayed case reproduces the table. The **immediate** case yields `companion_error` / exit `3` / `peer_invocation_error` — a different branch | **DISPROVED as unconditional** — variant A is timing-dependent, and the table presents one timing as the behaviour |
| the positive control (`status=success`, `ACK\n`) | the same companion allowed to finish | — | re-run live | the live re-run failed with `ENOTFOUND` after roughly three minutes; only a fake child reproduced `success` / `ACK\n` | **UNVERIFIABLE today** — the control is sound in principle but was not reproducible on this network |
| "the change is not observable through this framework" | only the post-change binary | a pre-change (`2.1.235`) counterfactual | — | no counterfactual was run, by either reader | **UNVERIFIABLE** — the conclusion is plausible and untested; `claude -p` emitting nothing until turn completion is the argument, and it was not measured against an older binary |
| `peer-runner.mjs`'s `sendSignal` targets the group before the pid | `plugins/engineer/scripts/peer-runner.mjs` | read the function | — | `targets.push(-handle.pgid)` then `targets.push(handle.pid)`, both signalled | **CONFIRMED** |
| "a `runtime`/`engineer` cancel delivers SIGTERM to companion and child together" | `plugins/runtime/scripts/` | search runtime for a peer-runner or a group kill | `grep -rn "child.kill\|process.kill\|peer-runner" plugins/runtime/scripts` | **runtime has no peer-runner.** Its generic timeout helper `runCommand` (`doctor.mjs`) spawns without `detached` and calls `child.kill('SIGTERM')` — a **single-PID** kill | **DISPROVED for the runtime half.** The engineer half is exact. Whether a child then survives is an inference, not a measurement; what is measured is that the group-first guarantee does not exist on the runtime path |

### 8.8 The host moved again — the cohort this brief serves is already stale

| Claim | Input | Control | Command | Raw output | Verdict |
| --- | --- | --- | --- | --- | --- |
| `2.1.236` installed 05:05 and `2.1.237` at 10:34 local on 2026-08-20 | the retained executables | each binary's own `--version`, and its file type | `ls -lat ~/.local/share/claude/versions/`; `"$bin" --version` | `2.1.236` → 05:05, `2.1.237` → 10:34, both Mach-O arm64 reporting their own version | **CONFIRMED to the minute** |
| the installed pair | live hosts | `codex --version` alongside | `claude --version`; `codex --version` | **`2.1.238 (Claude Code)`** / `codex-cli 0.148.0` | **SUPERSEDED** |
| `2.1.238` install time | the version store | — | same listing | **2026-08-21 05:35 — 19h01m after `2.1.237`** | **NEW** |
| §1.2's cohort miss | the recorded proof, and the matcher's own code | a known-`granted` tuple run through the matcher | read `doctor-20260820T041120Z-c4c83e`; read `cohortMatch` | `status: "unassured"`, reason *"no grant names the host pair claude 2.1.237 / codex 0.148.0"*, `direction: ahead`, host parity `pass`; `cohortMatch` = `tuples.some(t => HOSTS.every(h => sameRelease(hosts[h], t[h])))` — exact tuple equality, no range tolerance | **CONFIRMED** |
| §6's "Claude sits on a version for a median of about 2 days" | this machine's last two transitions | — | the timestamps above | `2.1.236`→`2.1.237` **5h29m**; `2.1.237`→`2.1.238` **19h01m** | **NOT WHAT THE LAST TWO SHOW** — both far under two days |

**Consequence, stated plainly for the owner decision.** `cohortMatch` is exact
tuple equality. The installed Claude is `2.1.238`. A grant whose cohort is
`[{claude: "2.1.237", codex: "0.148.0"}]` — with or without the `2.1.236` tuple
alongside — therefore resolves `unassured` on this machine **the moment it
ships**, for the same reason the first grant did: not drift, not a defect, a
cohort that no longer contains the installed pair. §6 predicted this in the
abstract while the machine was already producing the concrete case.

Three options exist and the choice is the owner's, not this document's.
`2.1.238` was **not reviewed here** — its 39 changelog items are outside this
brief's corpus — so naming it would grant an unreviewed tuple. Naming only the
reviewed tuples ships a grant that is immediately `unassured` but honest.
Extending the reviewed window to `2.1.238` before ratification costs one more
delta review and is the only path that ends with `covered` observed on this
machine. §6's own advice — *re-probe both host versions immediately before
ratification* — is what surfaced this, one day later.

### 8.9 The residual ledger (§4) — the attention correction has a mirror

| Claim | Input | Control | Command | Raw output | Verdict |
| --- | --- | --- | --- | --- | --- |
| eleven residuals carry on the existing grant | the packaged baseline | parse the sentinel block, not the prose | parse the record's JSON | 11 residuals; grant `claude-2-1-234-235-codex-0-147-0`; cohort `{2.1.234, 0.147.0}` and `{2.1.235, 0.147.0}`; seven packages, `image` absent | **CONFIRMED** |
| §4.13's correction: eight loader-residual rows are really **seven**, because `plugins/attention/skills/` is empty | all eight skill roots | `plugins/engineer/skills/` → 11 as a positive control | `ls -A` each root; `find … -name SKILL.md` | attention: 1 entry, **0** `SKILL.md`. **`companions`: 1 entry (`README.md`), 0 `SKILL.md`** — the identical condition. designer/engineer/founder 10 each, image 6, orchestrator 8, runtime 11 | **DISPROVED — the correction stops one row short.** The functional set is **six** packages, not seven. The brief found the vacuous `attention` row and did not check whether the same condition held elsewhere; it does |
| "eleven carried plus a per-package expansion approaches the cap" | the schema's residual cap | recompute with the corrected package count | arithmetic | `11 + 5 + 6 + 1 + 1 + 1 = 25` against a cap of 32 | **DISPROVED** — the cap pressure the paragraph invokes to argue for fewer rows is overstated |
| §3.5: the three-row digest collision | a throwaway repository | **a modified tracked file under the same setting** — a control the brief did not run | `git status --porcelain=v1 -z \| shasum -a 256` per state | untracked, setting unset → `803a04aa…0648`; setting `no`, same tree → `e3b0c442…b855`; unset, file removed → `e3b0c442…b855`; sha256 of the empty string → `e3b0c442…b855`. **Control**: modified tracked file under setting `no` is still reported (`M tracked.txt`, digest `6fea86d3…6e3f`) | **CONFIRMED, and narrowed** — the collision is confined to **untracked** files. Tracked modifications stay visible, so "work sat uncommitted" overstates the defect |
| §3.5: "5 packages across **55** sites" | `plugins/ scripts/ companions/` | several candidate definitions, files and occurrences counted separately | `grep -rIn 'status --porcelain' …` and variants; `rg -F 'git status --porcelain=v1'` | five packages exactly. Sites: **53** matching lines under the wording's own phrase; **52** occurrences across **43** files under the fully literal phrase; other definitions give 88, 69, 94 | **DISPROVED** — no definition yields 55 |
| §3.5: the ambiguous digest "appears **269 times** in this repository's live workflow state" | `.agentic-plugins/` | files and occurrences counted separately; corpus checked against `.gitignore` | `grep -rl` vs `grep -rIo`; `git ls-files .agentic-plugins` | **269 was a file count**, not an occurrence count — `grep -rl` today gives **274** files and `grep -rIo` gives **496** occurrences. `.agentic-plugins/state/` is gitignored (`.gitignore:55`), 0 tracked files | **DISPROVED and withdrawn as evidence** — mislabelled, and drawn from a machine-local, monotonically growing corpus no other reader can reproduce. The defect stands on the reproduction above |
| §5's two implementation consequences | the two test files | exact assertion messages | `grep -n` | `test-host-assurance-record.mjs:159` — `strictEqual(resolved.record.grants.length, 1, 'R2 ships one grant, alone')`; `test-assurance-monotonicity.mjs:154` — `assert.equal(result.target_grants, 1, 'HEAD ships exactly the first grant — R2 is one grant and nothing else')` | **CONFIRMED** — both exact |

### 8.10 Method notes, including the controls that caught this pass mid-error

Recorded because a control that never fires is not evidence that the measurement
was sound.

1. **Three zero-results in the local pass were invalid, and the controls said
   so.** The first §8.4 run used `grep -rI -- "$t" $R` with
   `R="plugins companions scripts"`. zsh does not word-split unquoted parameters,
   so `$R` arrived as one nonexistent path, `2>/dev/null` swallowed the error, and
   every count — including `CLAUDE_PLUGIN_ROOT`, known to be in the hundreds —
   returned `0`. The claims under test would have "passed". Naming the paths
   explicitly restored `427 / 4 / 32 / 61 / 151 / 3`.
2. **The binary probe was invalid the same way.** `strings -a … | grep -cx` gave
   `agent-turn-complete` 0 — and `notify` 0, which is impossible. Whole-line
   matching is wrong for a Rust binary's string blob; substring matching gives
   `notify` 40 and `agent-turn-complete` 1.
3. **A matcher invocation was invalid and a known-positive tuple caught it.**
   Calling `matchAssurance` without a plugin set returned `unassured` for R2's
   **granted** pair — a control that must return `covered`. §8.8's verdict
   therefore rests on the recorded doctor artifact and on reading `cohortMatch`,
   not on a hand-built call.
4. **One cross-host count was off by one and re-measurement fixed it**, which is
   why peer output is treated as claims to verify rather than conclusions to
   adopt: the reported twelve `Monitor` calls measure **11**. Every other
   cross-host finding adopted above was re-run locally first; the two that
   changed the local pass's own verdict — the whole-file hash reconstruction
   (§8.1) and the empty `companions` skills root (§8.9) — were re-measured before
   adoption.

**Four definitions the brief relies on are unstated, and a reader who guesses
wrong concludes the brief is wrong.** (a) The control counts are **matching-line**
counts; counting occurrences gives 433 / 5 / 66 / 158 instead of
427 / 4 / 61 / 151. (b) The "Tool availability" row uses the narrow
`allowed-tools` token — a plain `/tool/i` gives 5 for `2.1.234` and 1 for
`2.1.236`, and appears to break the sixteen-figure control. (c) The entry hashes
are taken over `"\n" + body`; nine other plausible conventions miss. (d) The
codex body hash is over the raw body with **no trailing newline**. None of these
changes a judgement, and all four should be written down. Relatedly, the Claude
corpus is called *pinned* but identified by a mutable `main` URL; pin the
immutable tag path instead, so the next lap does not need the reconstruction in
§8.1.

### 8.11 What this verification did not do

No live Codex skill invocation under `0.148.0`; no `/hooks` re-review after the
Codex upgrade; no `2.1.235` counterfactual for the SIGTERM probe (§8.7); no
Bedrock credential failure; no review of the `2.1.238` delta; and no fresh
`runtime:doctor` proof against the current pair — §8.8's verdict uses the
2026-08-20 artifact plus the version store, which decides cohort membership and
is not a substitute for the post-release proof ST5 owes. §8.6.1 adds the seven
unscreened hook rows to this list.
