> **Status: VERIFIED WITH CORRECTIONS — 2026-08-19. Not ratifiable as
> `review_provenance` in its original form; see §0.**
>
> The independent verification this document's first header asked for has now
> been run (macro `macro-plan-20260818T192357Z-a06395`, subtask ST1, engineer
> workflow `critique-20260818T195858Z-e55d5c`), by a session other than the one
> that authored the original. Every negative claim below had its control
> re-executed rather than accepted.
>
> **The verification did not confirm the original.** Seven claims were
> disproved, three of them in a way that changes what a reviewer must judge.
> The original assertions are preserved with strike-through or an explicit
> CORRECTION note rather than deleted, because what a control missed is itself
> evidence about how this brief was built.

# Grant review brief — claude 2.1.234 / codex 0.147.0

Prepared for the ADR-0053 §Decision 5 human review that the first assurance
grant requires. Runtime cannot produce this judgement; this document only
assembles measured inputs for it.

## 0. Verification result (added 2026-08-19)

**Three findings materially change the review.** Each is reproduced below with
the command that produced it.

**V1 — CRITICAL. Authentication is a consumed surface the original brief
omitted entirely, and the companion's classifier does not honour its own
contract on it.** `companions/claude-companion.mjs`'s `AUTH_REGEX` requires
`please run /login` (with the word "please"). The 2.1.234 binary carries a new
variant that omits it:

```
Anthropic profile login expired · Run /login to use your claude.ai account
instead, or re-authenticate the profile
```

Present in `~/.local/share/claude/versions/2.1.234`, absent from `2.1.233`
(delta control). Both binaries carry `Please run /login` 25 times, so the
extraction method is sound. Fed to the real classifier, the new wording yields
`status=peer_error / exit=1 / kind=peer_run_error`, while
`companions/contract.md` §5.4 requires expired authentication to be
`companion_error / 3 / peer_unauthenticated`. Control: `Invalid API key ·
Please run /login` correctly yields `companion_error / 3 /
peer_unauthenticated`.

**Attribution, measured — and this is where the finding differs from the
cross-host report that surfaced it.** The gap is **pre-existing, not created
by this delta**. `2.1.233` already shipped `Anthropic profile login expired ·
Re-authenticate your Anthropic profile`, and that wording fails `AUTH_REGEX`
too. 2.1.234 adds a third variant to a family the classifier already missed.
So this is not "the delta broke the contract" but "the contract was already
broken and the delta widened the surface" — which matters, because it makes
this a **residual on the pair under review**, not a blocking delta defect.
The review is nominally of the whole pair (§1), so it is in scope either way.

**V2 — CRITICAL. Background-task notification delivery is a consumed surface
that survives filtering, and the original brief never classified it.**
Changelog entry 49 moves between-turn background-task notifications inside
`<system-reminder>` tags. Four runbooks depend on that channel:

```
plugins/engineer/skills/investigate/SKILL.md:241  "Wait for the peer ensemble background notification"
plugins/designer/skills/investigate/SKILL.md:212  (same)
plugins/founder/skills/investigate/SKILL.md:161   (same)
plugins/engineer/skills/_shared/references/ensemble-protocol.md:122
```

**A control this verification itself got wrong, recorded because it is the same
failure this brief exists to catch.** The verifier's first pass measured
`grep -rn 'system-reminder' plugins/ companions/ scripts/` → **0 hits** and
concluded the line does not reach the framework. That control was aimed at the
wrong object: the framework does not *parse* the tag, it *depends on the
notification being delivered*. A zero-hit grep for a string the consumer never
reads is exactly the vacuous negative this document's original header warned
about.

**V3 — CRITICAL. The "the companion is non-interactive" argument is true and
does not bound the grant.** The grant covers the installed package set, not the
companion. 57 command runbooks under `plugins/*/commands/*.md` execute in the
**main interactive host session**, and the packaged baseline's Hooks row
records `plugins/attention`'s `Notification` sensor as reaching Claude Desktop
and VS Code. So the interactive-dialog, IDE-diff-tab, fullscreen-renderer,
`/tui`-restart and Remote Control lines cannot be dismissed by the companion
control — they are outside the *companion's* path, not outside the
*framework's*.

Nor can the grant be narrowed to terminal-only use to recover the argument:
every key `predicate` accepts is unobservable, so scoping with
`predicate.integrations` yields `unassured` rather than a narrower grant
(`UNOBSERVABLE_PREDICATE_KEYS`, verified by
`node --test --test-name-pattern='unobservable predicates are unassured'`).

**What survived verification.** The §2 quantitative table was re-derived with an
independent extractor and **every one of its seven counts is correct**
(§2 note). §1's "51 changelog lines" is correct (nonEmpty=51, bullets=51). All
four §4 residuals are real and are each recorded as open in the packaged
baseline. §3.3's substantive conclusion — no agent-team teammates are spawned —
survives.

**What was disproved, in brief** (details at each site): the companion flag
list (§2), the "no code resolves a projects path" claim (§2), the marketplace
control's target (§2), the duplicate `companions` entry (§1), the
team-vocabulary count (§3.3), the completeness of the surface table (§2), and
the sufficiency of "three lines survive" (§3).

## 1. Scope

- **Host tuple under review**: claude `2.1.234` / codex `0.147.0`
- **Against installed**: runtime `0.91.1`; packages attention 0.9.0,
  companions 0.4.0, designer 0.3.4, engineer 0.21.5, founder 0.4.4, image
  0.2.0, orchestrator 0.13.3.

  > **CORRECTION.** The original listed `companions` twice — "companions 0.3.0,
  > attention 0.9.0, companions 0.4.0". The first is the top-level release
  > package `companions/`; the grant namespace has only the plugin-set's single
  > `companions` key, which is the plugin at `0.4.0`. A grant naming
  > `companions: "0.3.0"` would fail `evaluatePackages` against an installed
  > `0.4.0`.
- **Delta since the packaged baseline** (observed 2026-08-16 at claude 2.1.233
  / codex 0.147.0): **exactly one Claude version**, 2.1.233 → 2.1.234.
  Codex is unchanged (`exact`).
- Source: local `~/.claude/cache/changelog.md` (no network fetch performed).
  The 2.1.234 entry carries **51** changelog lines. **Verified**: an
  independent extractor reports nonEmpty=51, bullets=51.

Note the review is nominally of the whole PAIR, not just the delta: no grant
has ever existed, so nothing about this pair has been reviewed under the
assurance mechanism before. What makes it tractable is that the packaged
baseline already documents this pair surface-by-surface at 2.1.233; the
incremental judgement is the 2.1.234 delta plus the carried residuals in §4 —
**plus, per V1, at least one pre-existing defect that only a whole-pair review
would have been obliged to find.**

## 2. Delta vs the ADR-0053 consumed-surface list — measured

| Surface | Lines in 2.1.234 | Reaches this framework? |
| --- | --- | --- |
| Hooks | **0** | No. Absence verified with a control: the same extractor finds 1 hook line in 2.1.204. |
| Plugin manifest | **0** | No. |
| Marketplace | 1 | **No**, but for a different reason than originally given — see the correction below. |
| Permission model | 9 | **Not resolvable by the companion argument** — see §3 and V3. |
| Sandbox | 1 | No contract change (an auto-mode fix that stops *spurious denials* after compaction; strictly an improvement). |
| Subagent / teammate | 2 | Partly — see §3. |
| Tool availability | 1 (`--allowed-tools` via `/tui` restart) | No: the companion passes no tool flags, and no runbook sets them. |
| **Authentication / error semantics** (added by verification) | 1 (entry 35) | **YES — V1.** Consumed by `companions`; the classifier misses the new wording. |
| **Background-task delivery** (added by verification) | 1 (entry 49) | **YES — V2.** Consumed by `engineer`, `designer`, `founder`. |
| **Security / pre-approval file access** (added by verification) | 1 (entry 6) | No on this machine — the change rejects Windows NT-namespace (`\??\`) paths and this framework runs on macOS. Listed because the original table had no row it could have been classified into. |

**Verification note on the counts.** Each of the original seven counts was
re-derived with an independent extractor over the entry the tool itself
delimits, and all seven match: hooks 0 (control: 2.1.204 → 1), manifest 0,
marketplace 1, sandbox 1, permission 9, subagent/teammate 2, tool
availability 1. **The counts are lexical**, however: `permission 9` is the
`/permission/i` count and does not include entry 6's "pre-approval file
accesses" or entry 23's trust prompt, and `subagent/teammate 2` does not
include entries 11/34 (`SendMessage`/`ListAgents`), 46 (`Agent` tool call
rendering) or 49. The three rows appended above are the classification those
lines needed; the remaining ones are dispositioned in the sweep below.

Two structural measurements bound part of the above:

- ~~**The companion is non-interactive.** `companions/claude-companion.mjs` runs
  `claude -p` and passes exactly `--effort --model --no-session-persistence
  --output-format --prompt-file`.~~

  > **CORRECTION (two errors).** First, the flag list is wrong.
  > `buildClaudeArgs` emits `-p --output-format text --no-session-persistence`
  > plus optional `--model` / `--effort`, and the prompt travels on **stdin**;
  > `--prompt-file` is the *companion's own* CLI flag, not something passed to
  > `claude`. The original confused the companion's input interface with the
  > argv it constructs. The narrow conclusion — no permission-mode, sandbox,
  > approval, or allow/deny-tool flag is passed — **is still true** of the
  > corrected list.
  >
  > Second, and materially: per **V3** this argument bounds the *companion*,
  > not the *grant*. 57 command runbooks run in the main interactive session.
  > Every "structurally outside its path" conclusion the original drew from
  > this bullet for interactive dialogs, the IDE diff tab, the fullscreen
  > renderer, `/tui` restart and Remote Control is withdrawn, and those lines
  > are re-dispositioned in §3.

- **`CLAUDE_CODE_PROJECT_DIR_NAME` (new in 2.1.234) is not consumed.** Zero
  references anywhere in `plugins/`, `companions/`, `scripts/` — re-measured
  with quoted globs against a working control (`CLAUDE_CONFIG_DIR` → 4 hits),
  because an unquoted `--include=*.md` glob is a known way to mistake a shell
  error for a zero result. ~~and no code resolves a per-project
  transcript/projects directory path.~~

  > **CORRECTION.** The second half is false.
  > `collectUsageRecordSources` (`plugins/runtime/scripts/lib/permission-usage-sources.mjs`)
  > recursively scans `~/.claude/projects/**` for `.jsonl` transcripts.
  >
  > **The conclusion survives, for a reason the original did not give**:
  > `collectRecordFiles` matches on the *file* name only and walks directories
  > by structure, so a changed per-project directory *name* does not affect it.
  >
  > **But the correction exposes a residual the original could not have
  > recorded** (§4.5): the same function resolves the Codex side through
  > `resolveCodexHome(env, homeDir)` — honouring `CODEX_HOME` — while the
  > Claude side is a hardcoded `join(homeDir, '.claude', 'projects')`. The
  > 2.1.234 entry describes exactly the configuration this asymmetry misreads:
  > "hosts that give each session its own config directory".

**Marketplace row correction.** The original justified "No" by measuring that
all 8 catalog entries use local relative sources (`./plugins/<name>`). That
tests catalog-**entry** sources; the 2.1.234 fix concerns `strictKnownMarketplaces`
accepting SCP-style **marketplace registration** sources. The recorded proof
shows this repository's registrations are Claude directory-backed and Codex
GitHub-backed — neither is SCP-style — so the row's verdict stands on the
corrected control.

## 3. What the reviewer actually has to judge

The original said three lines survive. **After V1–V3 that is not the case.**
The list below supersedes it.

**3.1 — `/permissions` can now be opened while Claude is working; rule changes
apply to the rest of the current turn.** (Unchanged from the original.) This
changes *when* permission rules take effect. Judgement: does the ADR-0038
advisor's causal account of prompts stay accurate when rules can change
mid-turn?

**3.2 — Session-scoped permission answers (including denies) were being dropped
when answering background subagent tool permission prompts — now fixed.**
`plugins/engineer` spawns *native* Claude subagents via the `Agent` tool, and
since 2.1.232 those spawns are backgrounded by default. Same area as the
residual in §4.2; the fix moves it in a safe direction. Judgement: accept as
improvement, or probe first.

**3.3 — "Default teammate model" removed from `/config`.** **Measured not to
reach this framework**: it spawns plain subagents and never agent-team
teammates.

  > **CORRECTION to the evidence, not the conclusion.** The original cited "3
  > `Agent({subagent_type})` occurrences" and "the only two matches for team
  > vocabulary". Re-measured: `subagent_type` appears 3 times but only one
  > (`agent-taxonomy.md:39`) is an invocation template — the others are a
  > reference line and baseline evidence prose. A case-insensitive
  > `agent[- ]team|teammate` search returns **11** matches, not two, all of them
  > prose in `host-parity-baseline.md`. A production search for
  > `TeamCreate|TeamDelete|ListAgents|SendMessage|CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
  > outside runtime docs returns nothing. The conclusion holds; the counts did
  > not.

**3.4 — (NEW, V1) The authentication classifier misses the Anthropic-profile
wording family.** Judgement: this is a defect in `companions`, pre-existing and
widened by 2.1.234. Grant it as an accepted-with-risk residual, or fix the
classifier before granting. Note the consequence is a *misclassified* error —
`peer_run_error` instead of `peer_unauthenticated` — which still surfaces the
stderr summary, so the operator sees a failure either way; what is lost is the
typed signal callers branch on.

**3.5 — (NEW, V2) Background-task notification delivery moved inside
`<system-reminder>` tags.** Judgement: three personas' investigate runbooks wait
on that notification. The change is a delivery-format change to a channel the
framework consumes but does not parse. Accept as improvement, or probe one
ensemble round before granting.

**3.6 — (NEW, V3) The interactive-surface lines the companion argument used to
dismiss.** Entries 18, 21, 24, 27, 28, 29, 32 (interactive dialogs, fullscreen
restart, IDE diff tab, Remote Control permission previews). Judgement: these
reach the main session the 57 command runbooks execute in, but each is a *fix*
in the safe direction and none changes a contract the framework encodes. The
reviewer must decide explicitly rather than inherit the withdrawn structural
dismissal.

## 4. Residuals the grant would carry

`grant.residuals` is required by the schema — ADR-0053 §Decision 6 notes that
without residuals assurance is strictly harder to satisfy than exactness.
Residuals 1–4 were already recorded as unprobed/unverified in the packaged
baseline; each was re-checked and each is still open. 5–7 are added by this
verification.

Schema shape (`runtime-host-assurance-1.0` `$defs.residual`): each needs
`surface`, `consumption` (`consumed` | `unadopted`), and `disposition`
(`accepted-with-risk` | `probe-pending` | `not-applicable`); a `consumed`
residual must additionally name a `consuming_package` that `grant.packages`
binds.

1. **`Notification` hook payload on Claude Desktop and VS Code.** consumed /
   probe-pending / `attention`. 2.1.233 fixed `Notification` hooks not firing
   for permission prompts on those hosts; the sensor branches on
   `notification_type` and the changelog says nothing about that field.
   Recorded in the baseline's Hooks row.
2. **Result collection from backgrounded native subagents.** consumed /
   probe-pending / `engineer`. Recorded in the baseline's Subagent row.
3. **Agent teams under the todo-tool withdrawal.** unadopted. Recorded in the
   baseline's Agent-teams row.
4. **Non-slash `claude plugin update` path.** consumed / probe-pending /
   `runtime`. The baseline says to treat the manual
   `claude plugin marketplace update` as still required until the non-slash
   update path is directly measured.
5. **(NEW) The Claude transcript scanner ignores `CLAUDE_CONFIG_DIR`.**
   consumed / probe-pending / `runtime`. `collectUsageRecordSources` hardcodes
   `~/.claude/projects` while honouring `CODEX_HOME` on the Codex side. Reached
   only through the ADR-0038 permission diagnosis, which is opt-in and was
   `not_requested` in the recorded proof.
6. **(NEW, V1) `AUTH_REGEX` misses the Anthropic-profile expiry family.**
   consumed / the reviewer's call between `accepted-with-risk` and
   `probe-pending` / `companions`.
7. **(NEW, V2) Background-notification delivery format.** consumed /
   probe-pending / the reviewer picks one of `engineer` / `designer` /
   `founder` (all three consume it; the schema binds one package per residual,
   so either record three residuals or name the one whose runbook is
   canonical).

## 5. What the grant needs (schema `runtime-host-assurance-1.0`)

Required: `id`, `state`, `reviewed_at`, `review_provenance`, `cohort`,
`packages`, `residuals`.

- `cohort` — an explicit finite set of complete `{claude, codex}` tuples.
  Per-host lists and ranges are deliberately **not** expressible, so the grant
  covers only tuples the reviewer names. Minimum here:
  `[{claude: "2.1.234", codex: "0.147.0"}]`.
- `packages` — the consuming package set and reviewed versions. **Not simply
  "everything installed"**: `plugins/runtime/docs/follow-ups.md` records that
  requiring every installed plugin makes assurance strictly harder to satisfy
  than exactness and relocates the treadmill ADR-0053 §Decision 6 exists to
  prevent. The set must be chosen by hand, and `unbound_packages` on the
  resulting verdict is what shows whether the choice was honest. Note that
  every package named must be at **exactly** the installed version, and that
  `runtime` will be at the version of the release that carries the grant —
  not `0.91.1`.
- `review_provenance` — the durable identity of this review. Never a version
  comparison, never something runtime derives. **This document is verification
  input, not owner provenance**; runtime only checks the reference string is
  non-empty, so the owner decision needs its own durable artifact.
- `residuals` — §4, in the schema shape given there.
- `predicate` — **omit it.** Every key the schema permits is unobservable and
  therefore yields `unassured`; an empty `predicate: {}` is the one form that
  does not block, and it scopes nothing.

## 6. Known consequence of granting

The cohort is a finite tuple set, so the next Claude version the operator
installs falls outside it and reads `unassured` again until a further review
lands. ADR-0053 §Neutral states this explicitly and does not claim to reduce
review latency (ADR-0052 measured review latency at 81.7% of one obligation
loop). Locally observed Claude versions sit on a plateau for a median of
2.2 days; historically the baseline read `current` in 42 of 70 doctor runs
(60.0%) over 46.7 days.

If the reviewer wants fewer laps, the lever available today is naming
**several** already-reviewed tuples in one cohort — not a range, and not a
future version.

## 7. Method note

Both passes of this document were built the same way and the second one
disproved the first, so the method is worth stating. Negative claims were
required to name a control; controls were re-executed rather than read; and
where a control returned zero, a positive control was run against a token known
to be present, because a zero from a broken command and a zero from a genuine
absence are indistinguishable in the output.

That discipline caught six of the seven corrections. It did **not** catch V2 —
the verifier ran a zero-hit grep for `system-reminder`, had a working method,
and still aimed it at the wrong object. The cross-host reviewer found it by
asking what the runbooks *wait for* rather than what they *parse*. Recorded
because it is the sharper lesson: a control can be methodologically sound and
still measure the wrong thing, and the defence against that is a second reader
who does not share the first one's frame.
