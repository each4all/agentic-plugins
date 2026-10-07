# Output File Rules (engineer:investigate `cited-brief` profile)

<!-- pipeline:begin output-rules-intro -->
Output-file conventions for the cited-brief profile of
`engineer:investigate`. This is the only engineer:investigate profile that
produces a separate user-facing artifact; every other profile, present or
future, writes phase notes through `state.mjs` to the workflow `.md` and
produces no standalone file.

engineer ships its own copy of these conventions (ADR-0010 §5 no
cross-plugin import; ADR-0029 §Neutral copy/adapt). The brief file is
`research_brief.md`, and `RESEARCH_OUTPUT_ROOT` overrides where it is saved.
<!-- pipeline:end output-rules-intro -->

**Names kept from Stage 1**: the filename `research_brief.md` and the
variable `RESEARCH_OUTPUT_ROOT` come from the Stage 1 `plugins/research` shape,
not renamed after the cited-brief profile, so existing briefs stay readable by
this profile's audit and parse logic and existing configurations keep working.
Per [ADR-0014](../../../../../../docs/adr/0014-plugins-research-deprecation.md)
(Amendment 2026-05-06 — `plugins/research` removed at Stage 2.5+ rather than
deprecated), both names are a stable interface across the absorption; renaming
either would be a separate ADR decision.

<!-- pipeline:begin output-rules-layout -->
---

## Directory structure

Each cited-brief is saved to its own per-topic directory under the
**resolved output root** (default `./output/`, or the value of
`RESEARCH_OUTPUT_ROOT` when set — see "Output root override" below):

```
<resolved-root>/YYYY-MM-DD_<topic-slug>/
└── research_brief.md
```

The brief is a single self-contained document.

---

## Directory naming

- `YYYY-MM-DD` — the date the cited-brief session started.
- `<topic-slug>` — derived from the user-supplied topic per the
  sanitization rules below; max 15 Unicode code points.

---

## Topic-slug sanitization

Apply in order. **Step 1 (traversal rejection) runs on the raw input
before any character stripping** — this is what prevents path-like inputs
from collapsing into innocuous-looking slugs.

1. **Traversal rejection (raw input)**: if the raw topic string contains
   `..` (any sequence of two or more consecutive dots), `/`, or `\`,
   reject the slug entirely and use the time-based fallback (see
   "Fallback"). Do NOT attempt to sanitize traversal-bearing input — it
   is safer to lose the slug than to accept a normalized form.
2. **Lowercase** the topic string.
3. **Strip filesystem-forbidden characters**: `:`, `*`, `?`, `"`, `<`,
   `>`, `|` are removed.
4. **Normalize whitespace**: spaces and tabs collapse to single `_`
   (underscore).
5. **Allowed character class** — keep `[a-z0-9_-]` and CJK characters
   (Hangul, Hanzi, Kana). Strip all others (emoji, punctuation, control
   chars, zero-width).
6. **Truncate at 15 Unicode code points** (characters). One CJK
   character is one code point.
7. **Remove trailing `_`** if present after truncation.

### Fallback

When sanitization produces an empty slug — empty input, traversal
rejected at step 1, or step 5 stripped everything — use the time-based
fallback for the entire directory name: `YYYY-MM-DD_HHMM`.
<!-- pipeline:end output-rules-layout -->

### Examples

| User topic | Resulting slug | Resulting directory |
|---|---|---|
| `Server-Sent Events vs WebSockets` | `server-sent_eve` | `2026-04-29_server-sent_eve` |
| `리서치 기능 도입 검토` | `리서치_기능_도입_검토` | `2026-04-29_리서치_기능_도입_검토` |
| `🎉🎊` (emoji-only) | (empty) → fallback | `2026-04-29_1430` |
| `../../etc/passwd` | (rejected at step 1) → fallback | `2026-04-29_1430` |
| `2025` | `2025` | `2026-04-29_2025` |

<!-- pipeline:begin output-rules-files -->
---

## Filename

The brief file is **always** named `research_brief.md`. Fixed — do not
parameterize, do not add suffixes for revisions. If a user wants to
preserve a previous version, they archive the entire previous directory
or rename it externally before re-running.

UTF-8 encoding. POSIX line endings (LF).

---

## Existing-directory handling

If `<resolved-root>/YYYY-MM-DD_<topic-slug>/` already exists when the
cited-brief profile is about to save, ask the user:

> The output directory `<path>` already exists with a previous
> brief. Choose:
>
> 1. **Overwrite** — replace the existing `research_brief.md` with the new one.
> 2. **Distinct directory** — save to a sibling directory with the time
>    suffix (e.g., `YYYY-MM-DD_my-topic_HHMM/`) so both briefs coexist.
> 3. **Abort** — do not save; present the brief inline only.

Default if the user does not respond: option 2 (distinct directory) — the
safest non-destructive choice.

The choice is per-session, not persisted.

The existing-directory gate runs at TWO points (per the cited-brief
profile flow in `SKILL.md`): once before dispatch (to avoid wasted
peer-host runs on a session the user will discard) and once implicitly at
save (the recorded decision is reused — the gate is not re-asked).

---

## Output language

The brief is written in the user's interaction language. Section headers
and the spec structure follow the user's language; the "Source language"
field inside the brief records the dominant language of cited sources
(may differ from the brief's writing language).

---

## Output root override (`RESEARCH_OUTPUT_ROOT`)

When the environment variable `RESEARCH_OUTPUT_ROOT` is set, that path
replaces `./output/` as the root of the per-topic directory hierarchy:

1. **Absolute path required**: relative paths and tilde-prefixed paths
   are rejected. The variable MUST be an absolute path (POSIX
   `/abs/path` or Windows `C:\abs\path`). When the value is empty,
   non-absolute, or fails resolution, the profile falls back to
   `./output/` as if the variable were unset.
2. **Auto-create on use**: the resolved root is created with `mkdir -p`
   semantics if it does not exist. Parent directories are created as
   needed.
3. **Sandbox enforcement**: the resolved root is the entire write sandbox
   for the cited-brief session. Any computed save path that resolves
   outside the root after symlink resolution is rejected before the file
   is written. This protects against slug fallback or sanitization bugs
   producing `..`-bearing paths despite Step 1 traversal rejection above.

The override applies session-wide and is not per-call. Re-running the
profile with the variable unset reverts to `./output/` automatically.

`RESEARCH_OUTPUT_ROOT` is the only output-path knob. The profile does not
accept a per-call `--output` flag, a slug override, or a custom filename.

---

## Other

- Create the resolved output root directory if it does not exist.
- Do not write outside the resolved root (sandbox enforced — see "Output
  root override" above).
- File encoding: UTF-8.
<!-- pipeline:end output-rules-files -->
