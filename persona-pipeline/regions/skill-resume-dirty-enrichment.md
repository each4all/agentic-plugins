When `drift == dirty`, run native git probes guarded by a baseline validity
check (the baseline commit object must be available via `git cat-file -e
<head>^{commit}` — guards against shallow / GC'd / rewritten / hand-edited
baselines):

1. `git log <BASE_HEAD>..HEAD --oneline` — commits since baseline.
2. `git diff --stat HEAD` — working-tree diff stat (untracked excluded).
3. `git log --diff-filter=R --name-status <BASE_HEAD>..HEAD` — renames.
4. `git log --diff-filter=D --name-status <BASE_HEAD>..HEAD` — deletes.

Each probe captures its own exit status — empty stdout with exit 0 prints a
per-probe `(none; ...)` placeholder; non-zero exit prints `(probe failed:
...)`. If the baseline commit object is not available, skip all four probes
and tell the user to hand-inspect the workflow file or `archive` it.

After the probes, **always** render the auto-reconcile-not-supported notice:

```
  current plugin does not auto-reconcile; review and decide [resume / archive / abort]
```
