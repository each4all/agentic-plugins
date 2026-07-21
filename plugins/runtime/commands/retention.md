---
description: ADR-0047 §7 citation-aware artifact retention — read-only plan, and an explicit dry-run/--execute apply that deletes only unpinned, over-cap, age-cleared runs of the runtime-owned families under a reviewed plan hash
argument-hint: "plan | apply --family <doctor|compat|settings> --expected-plan-hash <hash> [--execute] | resolve --family <f> [--format text|json]"
---

# Runtime - Retention

$ARGUMENTS

Run the ADR-0047 §7 retention surface. The planner is **read-only** and the
apply executor is **dry-run by default** — deletion happens only with an
explicit `--execute` AND the `--expected-plan-hash` of the plan you reviewed.

Deletion is confined to unpinned, over-cap, age-cleared run directories of the
three v1 runtime-owned families (`doctor`, `compat`, `settings`) under
`.agentic-plugins/runs/<family>/`. It never touches host config, never anything
outside `runs/`, never a pinned/live/latest/young/unreadable run, and never
`latest.json`.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/retention.mjs" $ARGUMENTS --repo-root "$REPO_ROOT"
```

## Subcommands

- **`plan`** — recompute the retention plan and print, per family: run count,
  pinned count, over-cap flag, the actionable (deletable) and pinned-overage
  (informational) splits, and the **plan hash** you review before applying. It
  deletes nothing and writes nothing.
- **`apply --family <f> --expected-plan-hash <hash>`** — DRY-RUN by default:
  reports which runs *would* be deleted for one family. Add `--execute` to
  actually delete. `--execute` REQUIRES `--expected-plan-hash` — a bare
  `--execute` is refused (ADR-0047 §7 plan-hash binding).
- **`resolve --family <f>`** — close an open write-ahead receipt left by an
  interrupted apply, re-inventorying its `started` targets. Never deletes.

## Safety contract (ADR-0047 §7)

Apply is guarded by, in order: dry-run default → an explicit reviewed plan hash
that must still match after the executor **recomputes** the plan under the
family lock (any drift — new citations/runs/pins/caps — is a **refusal with
re-present**) → `scan_complete` (an incomplete pin scan withholds all deletion,
because an unscannable source is treated as citing everything) → a real O_EXCL
family mutex (an **open receipt blocks new applies** until resolved) →
containment + no-follow validation **re-run at the destructive boundary** (a
symlink swapped in after planning is refused) → a last-instant age re-check
inside the lock (a run a live writer just touched is conceded, never deleted) →
a write-ahead receipt whose per-target `planned → started → completed|failed`
transitions survive a crash → per-invocation ceilings on deletions, bytes, and
wall-clock.

## Notes

- Caps reuse the inventory guidance (`DEFAULT_ARTIFACT_RETENTION_CAP` 20 /
  50 MiB). There is no persistent retention-policy config key at v1.
- Deletion is real recursive removal of the run directory (quarantine is
  rejected — a moved run breaks every pointer the pin scan protects). Safety
  comes from the layered guards above, not a second copy.
- The plan the operator reviews and the apply MUST use the same caps — the plan
  hash covers the caps, so a cap change is a deliberate re-review.
- `doctor:audit`-style widening of the family registry beyond doctor/compat/
  settings is a follow-up decision, not a config knob.
