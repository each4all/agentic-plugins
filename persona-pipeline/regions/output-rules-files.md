---

## Filename

The brief file is **always** named `{{brief_file}}`. Fixed — do not
parameterize, do not add suffixes for revisions. If a user wants to
preserve a previous version, they archive the entire previous directory
or rename it externally before re-running.

UTF-8 encoding. POSIX line endings (LF).

---

## Existing-directory handling

If `<resolved-root>/YYYY-MM-DD_<topic-slug>/` already exists when the
{{brief_profile}} profile is about to save, ask the user:

> The output directory `<path>` already exists with a previous
> brief. Choose:
>
> 1. **Overwrite** — replace the existing `{{brief_file}}` with the new one.
> 2. **Distinct directory** — save to a sibling directory with the time
>    suffix (e.g., `YYYY-MM-DD_my-topic_HHMM/`) so both briefs coexist.
> 3. **Abort** — do not save; present the brief inline only.

Default if the user does not respond: option 2 (distinct directory) — the
safest non-destructive choice.

The choice is per-session, not persisted.

The existing-directory gate runs at TWO points (per the {{brief_profile}}
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

## Output root override (`{{output_root_env}}`)

When the environment variable `{{output_root_env}}` is set, that path
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
   for the {{brief_profile}} session. Any computed save path that resolves
   outside the root after symlink resolution is rejected before the file
   is written. This protects against slug fallback or sanitization bugs
   producing `..`-bearing paths despite Step 1 traversal rejection above.

The override applies session-wide and is not per-call. Re-running the
profile with the variable unset reverts to `./output/` automatically.

`{{output_root_env}}` is the only output-path knob. The profile does not
accept a per-call `--output` flag, a slug override, or a custom filename.

---

## Other

- Create the resolved output root directory if it does not exist.
- Do not write outside the resolved root (sandbox enforced — see "Output
  root override" above).
- File encoding: UTF-8.
