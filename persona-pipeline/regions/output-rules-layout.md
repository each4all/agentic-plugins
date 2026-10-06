---

## Directory structure

Each {{brief_profile}} is saved to its own per-topic directory under the
**resolved output root** (default `./output/`, or the value of
`{{output_root_env}}` when set — see "Output root override" below):

```
<resolved-root>/YYYY-MM-DD_<topic-slug>/
└── {{brief_file}}
```

The brief is a single self-contained document.

---

## Directory naming

- `YYYY-MM-DD` — the date the {{brief_profile}} session started.
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
