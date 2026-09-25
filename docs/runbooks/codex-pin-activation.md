# Runbook — activating the Codex catalog pins (ADR-0061)

This is the owner's procedure for
[ADR-0061](../adr/0061-codex-installs-pinned-to-release-commits.md)
§Decision 5 (a), publisher activation. It also covers how to recover from an
activation that was published only in part. Activation pins every entry in
`.agents/plugins/marketplace.json` to the commit its release tag peels to, and
it sets the `activated` marker in `scripts/data/codex-pin-floors.json` in the
same commit. It is one-way.

Machine acceptance (§Decision 5 (b)) is a separate step, and it happens on
each machine afterwards. This runbook does not cover it.

## What does the writing

All writing is done by `scripts/sync-marketplace-versions.mjs`, which
`.github/workflows/release-please.yml` runs after every release and on every
`workflow_dispatch`:

- **Before activation:** it leaves the Codex catalog exactly as it is. The
  one exception is a run with `--activate`, which the workflow passes only
  when a `workflow_dispatch` sets the `activate_codex_pins` input.
- **With `--activate`, it is all or nothing.** Every entry's package must be
  released at its manifest version, meaning the tag `plugin-<p>-v<version>`
  resolves and its tree carries that version, and that version must meet the
  package's floor. If any of this fails, the writer writes nothing and exits
  1, including the Claude catalog.
- **After activation:** pins follow the manifest forward on every release,
  with no input needed. A package's first tag gives it its first pin.
- **It validates before the push.** Whatever it writes is checked against
  `HEAD`, the catalog as it was before the write, with the gates CI runs
  (`validate-marketplace`, `validate-versions`). A failure exits 1, so the
  job does not push. A `GITHUB_TOKEN` push triggers no workflow, so this is
  the only gate the bot's commit gets.

## Before dispatching

Run these on an up-to-date `main` with all tags:

```sh
git switch main && git pull --no-rebase && git fetch --tags
node scripts/sync-marketplace-versions.mjs --activate --check
```

This is a dry run. It exits 1 in both outcomes below, so tell them apart by
the output:

- **`catalog drift detected`.** This is the activation plan: one line per
  entry going `local → plugin-<p>-v<version>`, then
  `scripts/data/codex-pin-floors.json: activated false → true`. Check that
  every package is listed at the version you expect.
- **`refused — nothing was written`.** Each line names what blocks the
  activation. Common causes:
  - A package is below its floor. Release it first.
  - A package has no floor. Add one in a pull request.
  - A package's manifest version is not tagged. The release job has not
    finished yet.

`main` should also be green, and no release-please PR should be pending
merge. A release that lands while the job runs would move `main` under it
(see recovery case 2).

## Dispatching

```sh
gh workflow run release-please.yml --ref main -f activate_codex_pins=true
```

## After the run: verify

1. Find the bot's commit on `main`. Its subject is
   `chore(marketplace): sync catalog versions to release-please-manifest and activate the Codex catalog pins`.
   It must touch `.agents/plugins/marketplace.json` and
   `scripts/data/codex-pin-floors.json` together, and
   `.claude-plugin/marketplace.json` only if that catalog also had drift.
2. Check every pin: `git rev-parse <ref>^{commit}` must equal its `sha`. The
   validator does the same check:
   `node scripts/validate-marketplace.mjs --base <bot commit>^` and
   `node scripts/validate-versions.mjs` must both pass on `main`.
3. `phase:` in the validator's output reads `activated`.

## Partial outcomes, and how to recover

Two rules hold in every case:

- **Never revert to `local`.** The gates reject a revert, both the `local`
  entry itself and the cleared marker, when compared against an activated
  baseline.
- **Never move or recreate a tag.** A rollback is a forward release, followed
  by the pin the writer regenerates from it (§Decision 7).

**1. It failed before anything was published.** Symptoms: the writer refused,
the post-write validation failed, or the job stopped before the catalog push.
Nothing reached `main`, and the catalog is still `local`. Read the job log.
Fix the cause in a normal pull request: release the package that lags, add
the missing floor, or repair whatever validation named. Then dispatch again
with the input.

**2. The catalog push was rejected as non-fast-forward.** `main` moved while
the job ran, so nothing was published. Dispatch again. The new run checks out
the new `main` and plans against it. Never force-push.

**3. A later step failed after the catalog push.** The stage-doc sync, the
evidence check, or the release-obligation assertion failed. **The activation
is published.** Confirm that, using steps 1–3 of *After the run: verify*.
Then fix the later step's cause and dispatch again, with or without the
input:

- On an activated catalog that is already in sync, the writer does nothing.
- If `main` has moved (a release), it advances only the pins that moved.
- The input changes nothing once activation is published.

**4. A half state from a hand edit.** This state cannot come from the writer,
which writes the pins and the marker together. It can come from a
hand-staged commit or a hand-made revert, and the gates flag each form.

| State | What the gates say | Recovery |
| --- | --- | --- |
| Pins without the marker | `entries are pinned before activation` | Dispatch with the input. The writer completes the marker and keeps the pins. |
| A `local` entry after activation | `reverted from a pin to local` (against the baseline) | Dispatch with the input. The writer pins that entry forward to its current release. Without the input, the writer refuses it. |
| The marker without pins | `says activated, but no entry is pinned` | Dispatch with the input. The writer pins every `local` entry forward and leaves the marker set. |

After activation, every package's floor stays in the file. The gates reject
removing a floor or lowering it, compared against the baseline. A package
added after activation needs no floor: it has no pre-migration release to
guard against. It gets no Codex entry until its first release tag, and its
first pin after that. The first pin takes its `category` from that release's
`.codex-plugin/plugin.json` (`interface.category`).

## What activation does not do

- It does not change any machine. Each Codex install picks up the pins at its
  next marketplace refresh.
- Isolation from `main` holds on a given machine only once that machine
  passes §Decision 5 (b).
- `AGENTS.md`'s dated Codex limitation is reworded in the activation's own
  follow-up (§Implementation manifest S5). It is not reworded here.
