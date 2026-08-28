# Runtime Artifact Policy

`plugins/runtime` owns new runtime/operator configuration and artifacts under
`.agentic-plugins`, but not every path under that directory has the same git
policy.

Two artifact scopes exist, and they are governed differently:

- **Repo-relative** — `<repo>/.agentic-plugins/**`. Per-repository generated
  state, kept untracked by the gitignore policy below.
- **Machine-global** — `~/.agentic-plugins/**`. Per-machine state (ADR-0046 §4),
  outside every repository. See [Machine-global artifacts](#machine-global-artifacts).

Everything until that section is repo-relative.

## Trackable

- `.agentic-plugins/config.toml` may be committed when a repo intentionally
  wants shared runtime defaults such as model/effort preferences.
- Source docs, scripts, manifests, and tests remain in their normal tracked
  locations under `plugins/`, `scripts/`, `tests/`, `.github/`, and the
  marketplace catalog directories.

## Ignored

The following paths are generated local byproducts and must stay ignored:

- `.agentic-plugins/runs/` — runtime context, consensus, settings execution,
  doctor, and future run artifacts.
- `.agentic-plugins/state/` — workflow files, archives, peer-run ledgers,
  locks, and migration manifests.
- `.agentic-plugins/tmp/` — temporary operator process byproducts.
- `.agentic-plugins/cache/` — repo-local runtime caches.
- `.agentic-plugins/*.local.toml` — local runtime config overrides.
- `.claude/` — Claude host state and legacy engineer/orchestrator workflow
  storage.
- `.codex/` — Codex host state.
- `output/` — legacy plugin test output.

This policy makes `.agentic-plugins/state/` safe as an ignored generated
state home for canonical workflow writers and the explicit ADR-0025 migration
manifest. Existing `.claude/agentic-*` workflow storage remains a legacy
compatibility home until the operator runs `runtime:migrate workflow-storage
--apply`.

## Machine-global artifacts

`runtime:bootstrap` records **per-machine** state — which plugins this machine
selected, which steps a post-probe observed, which proofs bound to which
versions. Writing that into whichever consumer repository happened to invoke the
command is a category error ([ADR-0046](../../../docs/adr/0046-machine-bootstrap.md)
§3): the state does not belong to the repo, and the next repo would re-derive it.

ADR-0046 §4 therefore authorizes exactly one machine-global artifact home, within
M1 and below the [ADR-0035](../../../docs/adr/0035-runtime-active-execution-boundary-policy.md)
§4 ceiling. `~/.agentic-plugins/config.toml` is already an authorized user-global
agentic-plugins-owned write (ADR-0024 §5); this extends the same **ownership** to
artifacts. It is a *location* extension of M1, **not a new effect class**: no host
config, no credential, no network, no new executor.

### Root

```
~/.agentic-plugins/runs/bootstrap/<run-id>/run.json      run manifest (contract §5)
~/.agentic-plugins/runs/bootstrap/<run-id>/fragments/    rendered host-config fragments
~/.agentic-plugins/runs/bootstrap/<run-id>/proof/        proof metadata (contract §8.2)
~/.agentic-plugins/runs/bootstrap/latest.json            pointer to the newest run
~/.agentic-plugins/profiles/<name>.json                  portable machine profile (contract §4)
~/.agentic-plugins/.locks/bootstrap.lock                 family-wide creation/index lock
```

The home is resolved from the operator's home directory, never from `repoRoot`.
`.locks/` sits outside `runs/` deliberately: a lock file inside the family root
would be counted by the inventory below, and an otherwise-empty family would
report as `available` because a lock happened to exist.

**Git relevance: none, by construction.** The home is outside every repository,
so the `Ignored` list above neither covers it nor needs to. Being outside the
repo is what keeps machine-global state untracked — the gitignore policy is how
*repo-relative* generated state achieves the same end.

The one case where those two facts collide is a `$HOME` that **is** the current
repository (some devcontainers, some CI checkouts). Then the machine-global home
would be inside the repo and its "outside every repository" premise is false.
Bootstrap **fails closed** with a diagnostic rather than writing there; it does
not fall back to a repo-relative home, and it does not write and hope the path is
ignored. This is the posture the egress config's verified-ignored-local reader
already established (`inside-repo` → refuse), not a softer one invented here.

### Security

- **Directories `0700`, files `0600`**, where the platform supports it. The home
  holds an operator's machine layout; it is not world-readable. This governs what
  runtime *creates*: a pre-existing `~/.agentic-plugins` is left with the modes the
  operator gave it, because silently `chmod`-ing a directory they own is a mutation
  nobody asked for.
- **Atomic temp-file + rename for every write.** A crash never leaves a torn
  `run.json` or a half-written pointer. The one deliberate exception is the lock's
  own claim, which uses `link(2)`: `rename(2)` *replaces* its destination, so a
  temp-and-rename lock would silently overwrite an existing lock and hand two
  processes the family — `link(2)` fails `EEXIST` instead, which is the "claim it
  only if unclaimed" the rule is actually expressing.
- **Symlink refusal and canonical containment.** Every path component is checked,
  and the resolved real path must be under `~/.agentic-plugins/`. A symlinked
  component is refused rather than followed — which is why `profile export --out`
  does not exist, and why `--name` is validated against a strict charset (no `/`,
  no `\`, no `..`, no leading `.`, no NUL).
- **`$CODEX_HOME` is honored wherever it is set**; `~/.codex` is the default, not
  a hardcode.
- **Never a host-config write.** Fragments rendered under a run directory are
  *artifacts describing an edit*, never the edit. ADR-0041 §2c is not negotiable:
  the operator applies them.

**What these gates are for, stated so they are not over-read.** They defend against
**misconfiguration and accidental redirection** — a devcontainer whose `$HOME` is the
checkout, a symlink left by a moved home, a path built from the wrong root. They are
not a defense against a local adversary racing runtime inside the operator's own
`0700` home, for two structural reasons: anyone who can swap a path component between
the check and the write already has the operator's account (and could edit runtime's
own scripts instead), and closing that window properly requires fd-relative syscalls
(`openat`/`renameat` with `O_NOFOLLOW`) that Node does not expose at all. The
check-then-use window is therefore inherent, and saying so is better than implying a
guarantee that is not there.

### Pointers

Machine-global pointers render **home-relative** — `~/.agentic-plugins/runs/bootstrap/<run-id>`
— never absolute. An absolute path carries the operator's home layout (typically
their username) into an artifact, a report, and any terminal they paste it into.
This is the same reason the run manifest's `seeded_from` records a profile
**id and hash** and never a filesystem path (contract §5), and the same reason
the portable machine profile carries a hostname **hash prefix** rather than the
hostname (§4.2). (The rule's original illustration was the permission advisory
dropping raw transcript source paths; ADR-0057 removed that consumer, and the
rule is re-illustrated from surviving ones rather than deleted with its
example.)

Repo-relative pointers keep their existing repo-relative form. The two are
distinguishable on sight: a machine pointer starts with `~/`.

### Inventory

`runtime:doctor --artifact-inventory` reports the machine-global home alongside
the repo-relative one. The inventory is **scope-aware**, not one flat family
list — the two scopes have different roots, different retention, and different
deletion rules, and collapsing them would inventory each scope's families against
the other's root.

| Scope | Root | Families | Retention cap |
|---|---|---|---|
| repo | `<repo>/.agentic-plugins/runs/` | `compat`, `consensus`, `context`, `settings`, `doctor`, `permission` (historical — ADR-0057 §Decision 7 removed the producer, kept the family declared and readable), `notification`, `egress-launcher` | 20 runs |
| machine | `~/.agentic-plugins/` | `bootstrap` (under `runs/`), `profiles` | 10 runs; profiles exempt |

The machine scope also holds ONE non-family path that is deliberately not a run
family and deliberately not inventoried: `~/.agentic-plugins/runs/doctor/egress-intents/`,
the ADR-0048 §3 egress intent WAL. It is **side-effect state, not an artifact** —
each record exists to fence a future send against a message that may already be
on the operator's phone, and it is named by activation fingerprint rather than by
run id, so it has neither a run's identity nor a run's lifecycle. It must never
be swept by retention: deleting a fencing record is exactly the act that permits
a duplicate message, and the ADR-0048 contract makes that an OPERATOR decision
taken after checking the phone. It predates this note — the taxonomy above simply
never named it — and naming it here is what keeps a future inventory or retention
pass from adopting it by default.

Machine-scope inventory is metadata-only on the same terms as the repo scope: it
counts, sizes, and ages entries, and never reads an artifact body. It reports;
it does not delete.

### Retention

- **Bootstrap runs**: the last **10** are kept. Older run directories are reported
  as retention pressure and **never auto-deleted** — the same no-silent-destructive
  posture every other family has.
- **Profiles are never auto-deleted and never generate retention pressure.** A
  profile is the operator's portable input, not a generated byproduct; a
  machine may legitimately hold one profile or twenty, and "you have too many
  profiles" is not a diagnosis runtime is entitled to make.
- **Locks are reclaimed, not retained.** A stale lock — its owning pid gone, or its
  age past ten minutes — is broken by the next invocation, after an owner-token
  recheck, and the break is **reported**. The operator is never asked to hand-delete
  a lock file; if they find themselves wanting to, that is a bug to report. Age is
  measured from the lock file's **mtime**, not from the timestamp inside it: a body
  can carry a corrupt date (which would evict a live holder) or a future one (which
  would make the lock permanently unbreakable), and neither should be able to decide
  who holds the family.
- **Runs are never overwritten.** A run id is claimed by creating its directory, so
  a colliding id is refused rather than silently replacing a retained run — the same
  no-silent-destructive posture as retention itself.

## Validation

Run:

```sh
npm run validate:artifacts
```

The validator checks both `.gitignore` policy and `git check-ignore` behavior.
It also fails if generated artifact paths are already tracked in git. The
marketplace validation workflow runs the same check in CI.

The validator is **repo-scope only**, and correctly so: the machine-global home
is outside the repository, so there is no gitignore entry to validate and no
`git check-ignore` answer to assert. Its equivalent guarantee is the
fail-closed `$HOME`-is-the-repo refusal above, which is enforced in code and
tested, not in `.gitignore`.

For local operator visibility, `runtime:doctor --artifact-inventory` reports
metadata-only counts, byte totals, age metadata, and retention pressure for
generated `.agentic-plugins/runs/` families in both scopes. It does not read raw
artifact bodies and does not delete or compact anything. `runtime:doctor --record`
writes sanitized doctor proof/report artifacts under `.agentic-plugins/runs/doctor/`;
these artifacts contain proof metadata, hashes, byte counts, and version
matching data, not raw peer output or prompt text.
