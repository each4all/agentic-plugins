# Output File Rules

Output-file conventions for the research skill.

---

## Directory structure

Each research brief is saved to its own per-topic directory under the
**resolved output root** (default `./output/`, or the value of
`RESEARCH_OUTPUT_ROOT` when set — see "Output root override" below):

```
<resolved-root>/YYYY-MM-DD_<topic-slug>/
└── research_brief.md
```

The brief is a single self-contained document.

---

## Directory naming

- `YYYY-MM-DD` — the date the research session started.
- `<topic-slug>` — derived from the user-supplied topic per the
  sanitization rules below; max 15 Unicode code points.

---

## Topic-slug sanitization

Apply in order. **Step 1 (traversal rejection) runs on the raw input
before any character stripping** — this is what prevents path-like
inputs from collapsing into innocuous-looking slugs.

1. **Traversal rejection (raw input)**: if the raw topic string contains
   `..` (any sequence of two or more consecutive dots), `/`, or `\`,
   reject the slug entirely and use the time-based fallback
   (see "Fallback" below). Do NOT attempt to sanitize traversal-bearing
   input — it is safer to lose the slug than to accept a normalized form.
2. **Lowercase** the topic string.
3. **Strip filesystem-forbidden characters**: `:`, `*`, `?`, `"`, `<`, `>`,
   `|` are removed.
4. **Normalize whitespace**: spaces and tabs collapse to single `_`
   (underscore).
5. **Allowed character class** — keep `[a-z0-9_-]` and CJK characters
   (Hangul, Hanzi, Kana). Strip all others (emoji, punctuation,
   control chars, zero-width).
6. **Truncate at 15 Unicode code points** (characters). One CJK character
   is one code point.
7. **Remove trailing `_`** if present after truncation.

### Fallback

When sanitization produces an empty slug — empty input, traversal
rejected at step 1, or step 5 stripped everything — use the time-based
fallback for the entire directory name: `YYYY-MM-DD_HHMM`.

### Examples

| User topic | Resulting slug | Resulting directory |
|---|---|---|
| `Server-Sent Events vs WebSockets` | `server-sent_eve` | `2026-04-29_server-sent_eve` |
| `리서치 기능 도입 검토` | `리서치_기능_도입_검토` | `2026-04-29_리서치_기능_도입_검토` |
| `🎉🎊` (emoji-only) | (empty) → fallback | `2026-04-29_1430` |
| `../../etc/passwd` | (rejected at step 1) → fallback | `2026-04-29_1430` |
| `2025` | `2025` | `2026-04-29_2025` |

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
skill is about to save, ask the user:

> The output directory `<path>` already exists with a previous research
> brief. Choose:
>
> 1. **Overwrite** — replace the existing `research_brief.md` with the new one.
> 2. **Distinct directory** — save to a sibling directory with the time
>    suffix (e.g., `2026-04-29_my-topic_1430/`) so both briefs coexist.
> 3. **Abort** — do not save; present the brief inline only.

Default if the user does not respond: option 2 (distinct directory) —
the safest non-destructive choice.

The choice is per-session, not persisted.

---

## Output language

The brief is written in the user's interaction language. Section
headers and the spec structure follow the user's language; the
"Source language" field inside the brief records the dominant language
of cited sources (may differ from the brief's writing language).

---

## Output root override (`RESEARCH_OUTPUT_ROOT`)

When the environment variable `RESEARCH_OUTPUT_ROOT` is set, that path
replaces `./output/` as the root of the per-topic directory hierarchy.
The skill applies these semantics:

1. **Absolute path required**: relative paths and tilde-prefixed paths
   are rejected. The variable MUST be an absolute path (POSIX
   `/abs/path` or Windows `C:\abs\path`). When the value is empty,
   non-absolute, or fails resolution, the skill falls back to
   `./output/` as if the variable were unset.
2. **Auto-create on use**: the resolved root is created with `mkdir -p`
   semantics if it does not exist. Parent directories along the path
   are created as needed.
3. **Sandbox enforcement**: the resolved root is the entire write
   sandbox for the research session. Any computed save path that
   resolves outside the root after symlink resolution is rejected
   before the file is written. This protects against slug fallback or
   sanitization bugs producing `..`-bearing paths despite Step 1
   traversal rejection above.

The override applies session-wide and is not per-call. Re-running the
skill with the variable unset reverts to `./output/` automatically.

`RESEARCH_OUTPUT_ROOT` is the only output-path knob. The skill does
not accept a per-call `--output` flag, a slug override, or a custom
filename.

---

## Other

- Create the resolved output root directory if it does not exist.
- Do not write outside the resolved root (sandbox enforced — see
  "Output root override" above).
- File encoding: UTF-8.
